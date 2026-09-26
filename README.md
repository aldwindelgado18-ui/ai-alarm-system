# TEMPEST X - AI Motion Portal

TEMPEST X is a locally hosted camera-monitoring portal for managing cameras, motion alerts, schedules, recordings, and user access. The Flask backend serves the browser interface and persists application state in JSON files.

## Features

- Camera status and connection-event monitoring
- Motion detections, alert review, and acknowledgement
- Configurable schedules and holiday overrides
- Recording management and retention settings
- User roles and audit history
- Ubuntu systemd service installer

## Requirements

- Python 3.9 or later
- Windows for local development, or Ubuntu 22.04 or later for the provided service installer

Backend dependencies are listed in `backend/requirements.txt`.

## Run on Windows

From PowerShell in the project directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
python run.py
```

The portal opens at <http://localhost:5000/>. `run.py` starts the Flask server and opens a browser by default.

## Install on Ubuntu

The installer creates `/opt/tempest-x/.venv`, installs dependencies, and configures the `tempest-x` systemd service:

```bash
sudo bash ./install-ubuntu.sh
```

Open <http://127.0.0.1:5000/> on the Ubuntu host. The service runs as root and listens on loopback by default. See [UBUNTU.md](UBUNTU.md) for custom installation paths and service commands.

## Tests

Run the backend tests from the project directory:

```powershell
python -m unittest discover -s backend/tests -v
```

## Runtime data

On first start, the backend creates JSON files in the project root for settings, users, cameras, alerts, recordings, and event history. These are local application data and are excluded from Git by `.gitignore`; back them up separately if needed.

## Security

This project is intended for local development and controlled deployments. The current source includes development login credentials and a fixed Flask session secret. Change these before using real accounts or exposing the portal to other machines. Do not expose the built-in server directly to the internet; use an appropriately secured deployment setup.