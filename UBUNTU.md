# Ubuntu installation

TEMPEST X can run on Ubuntu 22.04 or newer with Python 3, Flask, Socket.IO,
and the existing JSON data store.

## Install

From the project directory:

```bash
sudo bash ./install-ubuntu.sh
```

The installer:

- installs Python and virtual-environment dependencies;
- creates `/opt/tempest-x/.venv`;
- installs the backend requirements;
- installs and starts `tempest-x.service`;
- runs the service as `root` so privileged network and capture operations are available.

Open `http://127.0.0.1:5000/` after installation. The default development account
is `superadmin` / `tempestx`; change credentials before exposing the service beyond
localhost.

## Service commands

```bash
sudo systemctl status tempest-x
sudo systemctl restart tempest-x
sudo journalctl -u tempest-x -f
```

To install somewhere else:

```bash
sudo TEMPEST_INSTALL_DIR=/srv/tempest-x bash ./install-ubuntu.sh
```

The Ubuntu launcher also enforces root when run directly:

```bash
sudo /opt/tempest-x/run.py
```

The current Network Settings screen persists settings on Ubuntu, but applying
OS-level static networking still depends on the host's network manager and is
not changed automatically by the installer.