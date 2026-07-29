import asyncio
import logging
import subprocess

from pathlib import Path
from core.actor import SourceActor
from core.types import PlaybackControls
from core.util.metadata import Metadata
from core.models import Image, Album, Artist, Track, Source

from .smb_manager import StorageSmbManager
from .storage_manager import StorageManager

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent / "web" / "www"
ALLOWED_FILE_EXT = [
    ".mp3",
    ".m4a",
    ".flac",
    ".wav",
    ".ogg",
    ".aac",
    ".dsf",
    ".dsf",
]
# Wait for LAN before first remount; keep checking so drops recover.
SMB_REMOUNT_INTERVAL_S = 10


class StorageExtension(SourceActor):
    def __init__(self, name, core, db, config):
        super().__init__()
        self._name = name
        self._core = core
        self._db = db
        self._config = config
        self._album_images_full_path = BASE_DIR / "images" / self._name
        self._album_images_web_path = Path("images") / self._name
        self._metadata = Metadata(cover_dir=self._album_images_full_path)
        self._username = self._config[self._name].get("username", None)
        self._password = self._config[self._name].get("password", None)
        self._smb = StorageSmbManager(
            name=self._name,
            core=self._core,
            db=self._db,
            username=self._username,
            password=self._password,
        )
        self._storage = StorageManager(name=self._name, core=self._core, db=self._db)
        self._remount_task = None
        self._auth_failed_devs = set()
        self._source = Source(
            name="Storage",
            uri=self._name,
            controls=[
                PlaybackControls.SEEK,
                PlaybackControls.PLAY,
                PlaybackControls.PAUSE,
                PlaybackControls.NEXT,
                PlaybackControls.PREVIOUS,
                PlaybackControls.REPEAT,
                PlaybackControls.SHUFFLE,
            ],
            state={},
        )

    @staticmethod
    def _is_lan_online() -> bool:
        """True when Wi-Fi/Ethernet is connected to a real LAN (not hotspot)."""
        try:
            result = subprocess.run(
                ["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "device"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in result.stdout.splitlines():
                parts = line.split(":")
                if len(parts) < 3:
                    continue
                dtype, state, connection = parts[0], parts[1], parts[2]
                if state != "connected":
                    continue
                if dtype not in ("wifi", "ethernet"):
                    continue
                if connection and "hotspot" in connection.lower():
                    continue
                return True
            return False
        except Exception as e:
            logger.debug(f"LAN online check failed: {e}")
            return False

    def _saved_smb_clients(self) -> dict:
        clients = (
            self._db.get_config().get(self._name, {}).get("smb_clients", {}) or {}
        )
        self._config.setdefault(self._name, {})["smb_clients"] = clients
        return clients

    async def _remount_saved_smb_clients(self) -> None:
        clients = self._saved_smb_clients()
        if not clients:
            return

        for dev, creds in clients.items():
            if dev in self._auth_failed_devs:
                continue
            try:
                await self._smb.drop_stale_mount(dev)
                if self._smb.is_mounted(dev):
                    continue
                await self._smb.mount_shared(
                    devs=[dev],
                    username=creds.get("username"),
                    password=creds.get("password", ""),
                )
                logger.info(f"Remounted SMB share '{dev}'")
            except PermissionError as e:
                self._auth_failed_devs.add(dev)
                logger.error(f"SMB remount auth failed for '{dev}': {e}")
            except (
                ValueError,
                ConnectionError,
                FileNotFoundError,
            ) as e:
                logger.warning(f"SMB remount deferred for '{dev}': {e}")
            except Exception as e:
                logger.error(f"SMB remount failed for '{dev}': {e}")

    async def _smb_remount_loop(self) -> None:
        was_online = False
        while self.running:
            try:
                online = self._is_lan_online()
                if online:
                    if not was_online:
                        self._auth_failed_devs.clear()
                        logger.info("Network online — remounting saved SMB shares")
                    await self._remount_saved_smb_clients()
                elif was_online:
                    logger.info("Network offline — pausing SMB remount")
                was_online = online
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"SMB remount monitor error: {e}")
            await asyncio.sleep(SMB_REMOUNT_INTERVAL_S)

    async def on_config_update(self, config):
        updated_config = config[self._name]
        if not updated_config:
            return

        if "username" in updated_config:
            username = updated_config["username"]
            self._username = None if username == "" else username

        if "password" in updated_config:
            password = updated_config["password"]
            self._password = None if password == "" else password

        await self._smb.set_credentials(
            username=self._username, password=self._password
        )

    async def on_start(self):
        self._saved_smb_clients()
        self._remount_task = asyncio.create_task(self._smb_remount_loop())
        await self._smb.samba_status()
        logger.info("Started")

    async def on_event(self, message):
        pass

    async def on_stop(self):
        if self._remount_task:
            self._remount_task.cancel()
            await asyncio.gather(self._remount_task, return_exceptions=True)
            self._remount_task = None
        logger.info("Stopped")

    async def on_start_service(self):
        logger.debug("Starting Service")
        return self._source

    async def on_stop_service(self):
        await self._core.request("playback.clear")
        return True

    def _build_track(self, uri: str) -> dict:
        cover_path, tags = self._metadata.extract_cover_and_tags(uri)
        image_uri = None

        if cover_path:
            image_full_path = Path(self._album_images_full_path) / cover_path
            image_web_path = Path(self._album_images_web_path) / cover_path

            if image_full_path.is_file():
                image_uri = str(image_web_path)

        obj: dict = {
            "uri": f"{self._name}:{uri}",
            "images": [Image(uri=image_uri)] if image_uri else [],
            "artists": frozenset(),
            "albums": frozenset(),
            "composers": frozenset(),
            "performers": frozenset(),
        }
        if tags.get("name"):
            obj["name"] = tags["name"]
        if tags.get("genre"):
            obj["genre"] = tags["genre"]
        if tags.get("date"):
            obj["date"] = tags["date"]
        if tags.get("disc_number"):
            obj["disc_no"] = tags["disc_number"]
        if tags.get("track_number"):
            obj["track_no"] = tags["track_number"]
        if tags.get("length"):
            obj["length"] = int(tags["length"])
        if tags.get("bitrate"):
            obj["bitrate"] = tags["bitrate"]
        if tags.get("album"):
            album = Album(
                uri=None, name=tags["album"], date=tags.get("date"), images=None
            )
            obj["albums"] = frozenset([album])
        if tags.get("artist"):
            obj["artists"] = frozenset(
                [Artist(uri=None, name=tags["artist"], images=None)]
            )
        return obj

    async def on_playback_uri(self, path: str) -> any:
        path = Path(path).as_uri()
        return f"{path}" if id else None

    async def on_lookup_track(self, path: str) -> Track:
        return Track(**self._build_track(path))

    async def on_directory(
        self, uri: str = None, limit: int | None = None, offset: int | None = None
    ):
        if uri == "storage":
            return self._storage.storages_list()
        else:
            return self._storage.directory(
                uri,
                extensions=ALLOWED_FILE_EXT,
                limit=limit,
                offset=offset,
            )

    def on_add_to_library(self, uri: str) -> bool:
        return self._handle_library_paths(uri, add=True)

    async def on_mount(self, dev: str):
        return await self._storage.storage_mount(dev)

    async def on_unmount(self, dev: str):
        return await self._storage.storage_unmount(dev)

    def on_add_shared(self, ip: str, username: str = None, password: str = None):
        return self._smb.add_shared(ip, username, password)

    async def on_mount_shared(self, devs: list[str]):
        # Remount must reuse saved SMB credentials; the UI only sends URIs.
        config_smb_clients = self._saved_smb_clients()
        for dev in devs:
            creds = config_smb_clients.get(dev) or {}
            await self._smb.mount_shared(
                devs=[dev],
                username=creds.get("username"),
                password=creds.get("password", ""),
            )
        return True

    async def on_unmount_shared(self, dev: str):
        return await self._smb.unmount_shared(dev)

    def on_list_smb_shared(self):
        return self._smb.list_smb_shared()

    def on_list_shares(self):
        return self._smb.list_shared_directories()

    async def on_unshare(self, uri: str):
        return await self._smb.unshare_directory(uri)

    async def on_share(self, uri: str, name: str = None, read_only: bool = False):
        return await self._smb.share_directory(uri, name, read_only)
