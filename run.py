#!/usr/bin/env python3
"""
AI Motion Portal Launcher
Run this script to start the complete system
"""

import os
import platform
import sys
import webbrowser
import subprocess
import time


def require_superuser():
    """Require root on Linux so OS-level network and capture operations work."""
    if platform.system().lower() == 'linux' and os.geteuid() != 0:
        print('TEMPEST X must be started as root on Ubuntu/Linux. Use: sudo ./run.py', file=sys.stderr)
        raise SystemExit(1)

def main():
    require_superuser()
    print("=" * 60)
    print("  TEMPEST X - AI MOTION PORTAL")
    print("=" * 60)
    print("\nStarting the AI Motion Portal System...")
    
    # Change to backend directory
    backend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend')
    os.chdir(backend_dir)
    
    # Ubuntu deployments install dependencies during setup; keep Windows startup compatible.
    if platform.system().lower() == 'windows':
        print("\nChecking dependencies...")
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', 'requirements.txt'],
                       capture_output=True)
    
    # Start the Flask server
    host = os.environ.get('TEMPEST_HOST', 'localhost')
    port = os.environ.get('TEMPEST_PORT', '5000')
    url = f'http://{host}:{port}'
    print(f"\nStarting Flask server on {url}")
    print("Opening browser in 3 seconds...")
    
    time.sleep(2)
    if os.environ.get('TEMPEST_OPEN_BROWSER', '1') == '1':
        webbrowser.open(url)
    
    # Run the app
    subprocess.run([sys.executable, 'app.py'])

if __name__ == '__main__':
    main()