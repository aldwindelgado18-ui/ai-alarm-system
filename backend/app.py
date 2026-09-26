from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import os
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import psutil
from functools import wraps
from datetime import datetime, timedelta

# Add backend directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database import db
from ai_simulator import ai_simulator
from alarm_wall import send_clip, send_xml, build_clip_message

# Initialize Flask app
app = Flask(__name__, static_folder='../frontend', static_url_path='')
app.config['SECRET_KEY'] = 'tempest-x-secret-key-2026'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(minutes=30)
CORS(app, origins=["http://tempestai.io", "http://localhost:5000"])
socketio = SocketIO(app, cors_allowed_origins=["http://tempestai.io", "http://localhost:5000"], async_mode='threading')

PUBLIC_API_PATHS = {
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/me',
    '/health',
}

OPERATOR_ENDPOINTS = {
    ('get_cameras', 'GET'),
    ('get_alerts', 'GET'),
    ('acknowledge_alert', 'POST'),
    ('get_stats', 'GET'),
    ('get_system_info', 'GET'),
    ('get_system_uptime', 'GET'),
    ('get_schedule_config', 'GET'),
    ('get_effective_schedule', 'GET'),
    ('get_alarm_wall_settings', 'GET'),
    ('get_recordings_config', 'GET'),
    ('get_recordings', 'GET'),
    ('get_recording', 'GET'),
    ('get_recordings_status', 'GET'),
    ('get_camera_connection_events', 'GET'),
}


@app.before_request
def require_authenticated_session():
    if request.path.startswith('/api/') and request.path not in PUBLIC_API_PATHS:
        user = session.get('user')
        if not user:
            return jsonify({'success': False, 'error': 'Session expired. Please sign in again.'}), 401
        login_at = session.get('login_at')
        if not login_at or time.time() - login_at >= 30 * 60:
            session.clear()
            return jsonify({'success': False, 'error': 'Session expired. Please sign in again.'}), 401
        if user.get('role') == 'operator' and (request.endpoint, request.method) not in OPERATOR_ENDPOINTS:
            return jsonify({'success': False, 'error': 'Operator access is read-only for this resource.'}), 403

# ============ WEBSOCKET EVENTS ============

@socketio.on('connect')
def handle_connect():
    if not session.get('user'):
        return False
    print(f'Client connected: {request.sid}')
    # Send initial data
    cameras = db.get_all_cameras()
    alerts = db.get_alerts(limit=20)
    stats = db.get_alert_stats()
    
    emit('initial_data', {
        'cameras': cameras,
        'alerts': alerts,
        'stats': stats
    })

@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')

def get_windows_network_interface():
    result = subprocess.run(
        ['netsh', 'interface', 'show', 'interface'],
        capture_output=True,
        text=True,
        check=True
    )
    for line in result.stdout.splitlines():
        if not line.strip() or line.strip().startswith('Admin State') or line.strip().startswith('---'):
            continue
        parts = re.split(r'\s{2,}', line.strip())
        if len(parts) < 4:
            continue
        admin_state, state, typ, name = parts[0], parts[1], parts[2], parts[3]
        if state.lower() == 'connected' and typ.lower() != 'loopback':
            return name
    raise RuntimeError('No connected Windows network interface found')


def get_interface_mac(interface_name):
    addresses = psutil.net_if_addrs().get(interface_name, [])
    for addr in addresses:
        if addr.family == socket.AF_LINK or getattr(socket, 'AF_PACKET', None) == addr.family:
            if addr.address:
                return addr.address
    return ''


def prefix_to_netmask(prefix_length):
    try:
        prefix = int(prefix_length)
    except (TypeError, ValueError):
        return ''
    mask = (0xffffffff << (32 - prefix)) & 0xffffffff
    return '.'.join(str((mask >> i) & 0xff) for i in (24, 16, 8, 0))


def parse_dns_servers(netsh_output):
    dns_servers = []
    read_next = False
    for line in netsh_output.splitlines():
        text = line.strip()
        if not text:
            continue
        if re.match(r'^(?:DNS servers configured through.*:|Statically Configured DNS Servers:)', text, re.IGNORECASE):
            parts = text.split(':', 1)
            if len(parts) == 2 and parts[1].strip():
                dns_servers.append(parts[1].strip())
            read_next = True
            continue
        if read_next and re.match(r'^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$', text):
            dns_servers.append(text)
            continue
        read_next = False
    return dns_servers


def get_windows_network_info():
    interface_name = get_windows_network_interface()

    address_result = subprocess.run(
        ['netsh', 'interface', 'ip', 'show', 'address', f'name={interface_name}'],
        capture_output=True,
        text=True,
        check=True
    )

    ip_address = ''
    subnet_mask = ''
    gateway = ''
    for line in address_result.stdout.splitlines():
        if 'IP Address' in line and not ip_address:
            match = re.search(r'IP Address\s*:\s*([0-9\.]+)', line)
            if match:
                ip_address = match.group(1).strip()
        if 'Subnet Prefix' in line and not subnet_mask:
            match = re.search(r'Subnet Prefix\s*:\s*[0-9\.]+/(\d+)', line)
            if match:
                subnet_mask = prefix_to_netmask(match.group(1))
        if 'Subnet Mask' in line and not subnet_mask:
            match = re.search(r'Subnet Mask\s*:\s*([0-9\.]+)', line)
            if match:
                subnet_mask = match.group(1).strip()
        if 'Default Gateway' in line and not gateway:
            match = re.search(r'Default Gateway\s*:\s*([0-9\.]+)', line)
            if match:
                gateway = match.group(1).strip()

    dns_result = subprocess.run(
        ['netsh', 'interface', 'ip', 'show', 'dns', f'name={interface_name}'],
        capture_output=True,
        text=True,
        check=True
    )
    dns_servers = parse_dns_servers(dns_result.stdout)

    mac_address = get_interface_mac(interface_name)

    return {
        'interface': interface_name,
        'ip': ip_address,
        'subnet': subnet_mask,
        'gateway': gateway,
        'dns': dns_servers,
        'mac': mac_address
    }


def apply_windows_network_settings(settings):
    interface_name = get_windows_network_interface()
    mode = settings.get('mode', 'dhcp')

    if mode == 'dhcp':
        subprocess.run(
            ['netsh', 'interface', 'ip', 'set', 'address', f'name={interface_name}', 'source=dhcp'],
            check=True
        )
        subprocess.run(
            ['netsh', 'interface', 'ip', 'set', 'dns', f'name={interface_name}', 'source=dhcp'],
            check=True
        )
    else:
        ip = settings.get('static_ip')
        mask = settings.get('static_subnet')
        gateway = settings.get('static_gateway')
        dns = settings.get('static_dns')
        subprocess.run(
            ['netsh', 'interface', 'ip', 'set', 'address', f'name={interface_name}', 'static', ip, mask, gateway, '1'],
            check=True
        )
        subprocess.run(
            ['netsh', 'interface', 'ip', 'set', 'dns', f'name={interface_name}', 'static', dns, 'primary'],
            check=True
        )


# ============ API ROUTES ============

# Serve frontend
@app.route('/')
def serve_frontend():
    return send_from_directory('../frontend', 'index.html')

@app.route('/logo/<path:filename>')
def serve_logo(filename):
    logo_dir = os.path.join(os.path.dirname(__file__), '..', 'logo')
    if '..' in filename or '/' in filename or '\\' in filename:
        return {'error': 'Invalid filename'}, 400
    return send_from_directory(logo_dir, filename)

# Serve recordings
@app.route('/recordings/<filename>')
def serve_recording(filename):
    if not session.get('user'):
        return {'error': 'Authentication required'}, 401
    recordings_dir = os.path.join(os.path.dirname(__file__), '..', 'recordings')
    if not os.path.exists(recordings_dir):
        os.makedirs(recordings_dir)
    
    # Validate filename to prevent directory traversal
    if '..' in filename or '/' in filename or '\\' in filename:
        return {'error': 'Invalid filename'}, 400
    
    file_path = os.path.join(recordings_dir, filename)
    if not os.path.exists(file_path):
        return {'error': 'Recording not found'}, 404
    
    return send_from_directory(recordings_dir, filename)

# Authentication Routes
@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
    
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({'success': False, 'error': 'Username and password required'}), 400
    
    user = db.verify_login(username, password)
    if not user:
        return jsonify({'success': False, 'error': 'Invalid credentials'}), 401
    
    session.clear()
    session.permanent = True
    session['user'] = {
        'id': user.get('id'),
        'username': user.get('username'),
        'role': user.get('role')
    }
    session['login_at'] = time.time()
    return jsonify({'success': True, 'user': user, 'session_timeout_minutes': 30}), 200

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'}), 200

@app.route('/api/auth/me', methods=['GET'])
def get_current_user():
    user = session.get('user')
    return jsonify({'success': bool(user), 'user': user, 'session_timeout_minutes': 30}), 200 if user else 401

# Camera Management
def get_actor():
    return session.get('user', {}).get('username', 'System')

@app.route('/api/cameras', methods=['GET'])
def get_cameras():
    cameras = db.get_all_cameras()
    return jsonify({'success': True, 'cameras': cameras})

@app.route('/api/cameras', methods=['POST'])
def add_camera():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
    
    try:
        camera = db.add_camera(data)
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    db.add_audit_event(get_actor(), 'Added camera', 'camera', camera['id'], {'name': camera['name']})
    return jsonify({'success': True, 'camera': camera})

@app.route('/api/cameras/<int:camera_id>', methods=['PUT'])
def update_camera(camera_id):
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
    
    camera = db.update_camera(camera_id, data)
    if not camera:
        return jsonify({'success': False, 'error': 'Camera not found'}), 404
    db.add_audit_event(get_actor(), 'Updated camera', 'camera', camera_id, {'name': camera.get('name')})
    # emit camera update to clients
    try:
        socketio.emit('camera_updated', camera)
    except Exception:
        pass

    return jsonify({'success': True, 'camera': camera})

@app.route('/api/cameras/<int:camera_id>', methods=['DELETE'])
def delete_camera(camera_id):
    success = db.delete_camera(camera_id)
    if not success:
        return jsonify({'success': False, 'error': 'Camera not found'}), 404
    db.add_audit_event(get_actor(), 'Removed camera', 'camera', camera_id)

    try:
        socketio.emit('camera_deleted', {'camera_id': camera_id})
    except Exception:
        pass
    
    return jsonify({'success': True})

# Alert Management
@app.route('/api/alerts', methods=['GET'])
def get_alerts():
    limit = request.args.get('limit', 50, type=int)
    acknowledged = request.args.get('acknowledged', 'false').lower() == 'true'
    
    alerts = db.get_alerts(limit=limit, acknowledged=acknowledged)
    return jsonify({'success': True, 'alerts': alerts})

@app.route('/api/alerts/<int:alert_id>/acknowledge', methods=['POST'])
def acknowledge_alert(alert_id):
    data = request.json or {}
    user = data.get('user', 'Operator')
    
    alert = db.acknowledge_alert(alert_id, user)
    if not alert:
        return jsonify({'success': False, 'error': 'Alert not found'}), 404
    
    # Broadcast update to all clients
    socketio.emit('alert_acknowledged', alert)
    
    return jsonify({'success': True, 'alert': alert})

@app.route('/api/stats', methods=['GET'])
def get_stats():
    stats = db.get_alert_stats()
    return jsonify({'success': True, 'stats': stats})

@app.route('/api/system', methods=['GET'])
def get_system_info():
    cpu_load = psutil.cpu_percent(interval=0.1)
    ram_usage = psutil.virtual_memory().percent
    disk = psutil.disk_usage(os.path.abspath(os.sep))
    root_disk = disk.percent

    core_temp = None
    gpu_temp = None
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for sensor, entries in temps.items():
                for entry in entries:
                    if entry.label.lower().startswith('core') or 'cpu' in entry.label.lower():
                        core_temp = entry.current
                    if 'gpu' in entry.label.lower():
                        gpu_temp = entry.current
        if core_temp is None:
            for entries in temps.values():
                if entries:
                    core_temp = entries[0].current
                    break
    except Exception:
        pass

    system_health = {
        'cpu_load': round(cpu_load, 1),
        'ram_usage': round(ram_usage, 1),
        'core_temp': round(core_temp, 1) if core_temp is not None else None,
        'root_disk': round(root_disk, 1),
        'storage_used': round(root_disk, 1),
        'disk_total_bytes': disk.total,
        'disk_used_bytes': disk.used,
        'disk_free_bytes': disk.free,
        'gpu_temp': round(gpu_temp, 1) if gpu_temp is not None else None,
        'status': 'Critical' if max(cpu_load, ram_usage, root_disk) >= 90 else ('Warning' if max(cpu_load, ram_usage, root_disk) >= 75 else 'Normal')
    }
    return jsonify({'success': True, 'system': system_health})


@app.route('/api/system/uptime', methods=['GET'])
def get_system_uptime():
    try:
        boot = psutil.boot_time()  # seconds since epoch
        now = time.time()
        uptime_seconds = int(now - boot)
        return jsonify({'success': True, 'uptime_seconds': uptime_seconds, 'boot_time': int(boot)})
    except Exception as exc:
        return jsonify({'success': False, 'error': str(exc)}), 500

@app.route('/health', methods=['GET'])
def health_check():
    try:
        boot = psutil.boot_time()  # seconds since epoch
        now = time.time()
        uptime_seconds = int(now - boot)
        return jsonify({'success': True, 'status': 'OK', 'uptime_seconds': uptime_seconds, 'boot_time': int(boot)})
    except Exception as exc:
        return jsonify({'success': False, 'status': 'ERROR', 'error': str(exc)}), 500

# Alarm Integration Settings
@app.route('/api/settings', methods=['GET'])
def get_settings():
    settings = dict(db.get_settings())
    settings.pop('password', None)
    return jsonify({'success': True, 'settings': settings})

@app.route('/api/settings', methods=['POST'])
def save_settings():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400

    required = ['site_name', 'site_id', 'server', 'port', 'sender', 'receiver']
    for field in required:
        if not data.get(field):
            return jsonify({'success': False, 'error': f'{field} is required'}), 400

    settings = db.update_settings(data)
    db.add_audit_event(get_actor(), 'Updated alarm settings', 'settings')
    return jsonify({'success': True, 'settings': settings})

@app.route('/api/settings/thresholds', methods=['POST'])
def save_settings_thresholds():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400

    settings = db.update_settings({
        'confidence_threshold': int(data.get('confidence_threshold', 70)),
        'detection_interval': int(data.get('detection_interval', 10))
    })
    db.add_audit_event(get_actor(), 'Updated AI detection settings', 'settings')
    return jsonify({'success': True, 'settings': settings})


@app.route('/api/settings/alarm-wall', methods=['GET'])
def get_alarm_wall_settings():
    settings = db.get_settings()
    return jsonify({'success': True, 'settings': {
        key: settings.get(key, default)
        for key, default in {
            'alarm_wall_enabled': False,
            'alarm_wall_host': '',
            'alarm_wall_port': 9100,
            'alarm_wall_device_id': settings.get('device_id', ''),
            'alarm_wall_include_clip': True,
            'alarm_wall_timeout': 10
        }.items()
    }})


@app.route('/api/settings/alarm-wall', methods=['POST'])
def save_alarm_wall_settings():
    data = request.get_json() or {}
    host = str(data.get('alarm_wall_host', '')).strip()
    if data.get('alarm_wall_enabled') and not host:
        return jsonify({'success': False, 'error': 'Alarm Wall host is required when integration is enabled'}), 400
    try:
        port = int(data.get('alarm_wall_port', 9100))
        timeout = int(data.get('alarm_wall_timeout', 10))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': 'Port and timeout must be whole numbers'}), 400
    if not 1 <= port <= 65535 or not 1 <= timeout <= 120:
        return jsonify({'success': False, 'error': 'Port must be 1-65535 and timeout must be 1-120 seconds'}), 400
    settings = db.update_settings({
        'alarm_wall_enabled': bool(data.get('alarm_wall_enabled', False)),
        'alarm_wall_host': host,
        'alarm_wall_port': port,
        'alarm_wall_device_id': str(data.get('alarm_wall_device_id', '')).strip(),
        'alarm_wall_include_clip': bool(data.get('alarm_wall_include_clip', True)),
        'alarm_wall_timeout': timeout
    })
    db.add_audit_event(get_actor(), 'Updated Alarm Wall XML/TCP settings', 'settings')
    return jsonify({'success': True, 'settings': settings})


@app.route('/api/settings/alarm-wall/test', methods=['POST'])
def test_alarm_wall_settings():
    settings = db.get_settings()
    data = request.get_json() or {}
    host = str(data.get('alarm_wall_host', settings.get('alarm_wall_host', ''))).strip()
    try:
        port = int(data.get('alarm_wall_port', settings.get('alarm_wall_port', 9100)))
        timeout = int(data.get('alarm_wall_timeout', settings.get('alarm_wall_timeout', 10)))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': 'Port and timeout must be whole numbers'}), 400
    if not host:
        return jsonify({'success': False, 'error': 'Alarm Wall host is required'}), 400
    if not 1 <= port <= 65535 or not 1 <= timeout <= 120:
        return jsonify({'success': False, 'error': 'Port must be 1-65535 and timeout must be 1-120 seconds'}), 400
    test_recording = {'id': 0, 'camera_id': 0, 'camera_name': 'Connection Test', 'filename': '', 'duration': 0, 'size_mb': 0}
    payload = build_clip_message(test_recording, data.get('alarm_wall_device_id', settings.get('alarm_wall_device_id', '')), include_clip=False)
    try:
        send_xml(host, port, payload, timeout)
    except (OSError, ValueError) as exc:
        return jsonify({'success': False, 'error': str(exc)}), 502
    return jsonify({'success': True, 'message': f'XML test message sent to {host}:{port}', 'bytes_sent': len(payload)})

@app.route('/api/settings/network', methods=['GET'])
def get_network_settings():
    settings = db.get_network_settings()
    current_network = None
    if platform.system().lower() == 'windows':
        try:
            current_network = get_windows_network_info()
        except Exception as exc:
            current_network = {'error': str(exc)}
    settings['current_network'] = current_network
    return jsonify({'success': True, 'settings': settings})

@app.route('/api/settings/network', methods=['POST'])
def save_network_settings():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400

    mode = data.get('mode', 'dhcp')
    if mode not in ('dhcp', 'static'):
        return jsonify({'success': False, 'error': 'Invalid network mode'}), 400

    if mode == 'static':
        required_fields = ['static_ip', 'static_subnet', 'static_gateway', 'static_dns']
        for field in required_fields:
            if not data.get(field):
                return jsonify({'success': False, 'error': f'{field} is required for static mode'}), 400

    settings = db.update_network_settings(data)

    if platform.system().lower() == 'windows':
        try:
            apply_windows_network_settings(settings)
        except subprocess.CalledProcessError as exc:
            return jsonify({
                'success': False,
                'error': 'Failed to apply Windows network settings. Ensure the process runs as administrator and the interface is available.',
                'details': str(exc)
            }), 500
        except Exception as exc:
            return jsonify({
                'success': False,
                'error': 'Failed to apply Windows network settings.',
                'details': str(exc)
            }), 500
    else:
        # Persist settings, but OS-level application is not supported on non-Windows platforms yet.
        pass

    db.add_audit_event(get_actor(), 'Updated network settings', 'settings')
    return jsonify({'success': True, 'settings': settings})

@app.route('/api/system/export', methods=['GET'])
def export_system():
    system = db.get_system_export()
    return jsonify({'success': True, 'system': system})

@app.route('/api/system/import', methods=['POST'])
def import_system():
    data = request.json
    if not data or not isinstance(data, dict):
        return jsonify({'success': False, 'error': 'No import data provided'}), 400

    try:
        system = db.import_system_config(data)
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except Exception as exc:
        return jsonify({'success': False, 'error': 'Import failed'}), 500

    return jsonify({'success': True, 'system': system})

@app.route('/api/system/reboot', methods=['POST'])
def reboot_system():
    def restart_process():
        # Give the response time to return before restarting
        time.sleep(1)
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as exc:
            print(f'Failed to reboot portal: {exc}')

    threading.Thread(target=restart_process, daemon=True).start()
    return jsonify({'success': True, 'message': 'Portal restart initiated.'})

@app.route('/api/schedule', methods=['GET'])
def get_schedule_config():
    return jsonify({'success': True, 'schedule': db.get_schedule_config()})

@app.route('/api/schedule', methods=['POST'])
def save_schedule_config():
    data = request.json or {}
    schedule = db.update_schedule_config(data)
    db.add_audit_event(get_actor(), 'Updated schedule', 'schedule')
    socketio.emit('schedule_updated', schedule)
    return jsonify({'success': True, 'schedule': schedule})

@app.route('/api/schedule/manual', methods=['POST'])
def set_manual_schedule():
    data = request.json or {}
    mode = data.get('mode')
    if mode not in ('armed', 'disarmed', None):
        return jsonify({'success': False, 'error': 'Invalid manual override mode'}), 400

    override = None
    if mode is not None:
        override = {
            'mode': mode,
            'set_at': datetime.now().isoformat()
        }

    schedule = db.set_manual_override(override)
    db.add_audit_event(get_actor(), 'Changed monitoring mode', 'schedule', details={'mode': mode or 'automatic'})
    socketio.emit('schedule_updated', schedule)
    return jsonify({'success': True, 'schedule': schedule})

@app.route('/api/schedule/effective', methods=['GET'])
def get_effective_schedule():
    reference = request.args.get('time')
    if reference:
        try:
            parsed = datetime.fromisoformat(reference)
            state = db.get_effective_schedule_state(parsed)
        except ValueError:
            state = db.get_effective_schedule_state()
    else:
        state = db.get_effective_schedule_state()
    return jsonify({'success': True, 'state': state})


@app.route('/api/schedule/backup', methods=['GET'])
def get_schedule_backup():
    backup = db.get_schedule_backup()
    if not backup:
        return jsonify({'success': False, 'error': 'No backup available'}), 404
    return jsonify({'success': True, 'backup': backup})


@app.route('/api/schedule/restore', methods=['POST'])
def restore_schedule():
    restored = db.restore_schedule_from_backup()
    if not restored:
        return jsonify({'success': False, 'error': 'No backup to restore'}), 404
    # Broadcast new schedule to clients if needed
    socketio.emit('schedule_updated', restored)
    return jsonify({'success': True, 'schedule': restored})

# User Management (Super Admin Only)
@app.route('/api/users', methods=['GET'])
def get_users():
    users = db.get_all_users()
    return jsonify({'success': True, 'users': users})

@app.route('/api/users', methods=['POST'])
def create_user():
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
    
    # Validate required fields
    if not data.get('username') or not data.get('email'):
        return jsonify({'success': False, 'error': 'Username and email are required'}), 400
    
    # Check if user already exists
    existing_user = db.get_user_by_username(data.get('username'))
    if existing_user:
        return jsonify({'success': False, 'error': 'Username already exists'}), 409
    
    user = db.create_user(data)
    db.add_audit_event(get_actor(), 'Created user', 'user', user['id'], {'username': user['username']})
    socketio.emit('user_created', user)
    return jsonify({'success': True, 'user': user}), 201

@app.route('/api/users/<int:user_id>', methods=['GET'])
def get_user(user_id):
    user = db.get_user(user_id)
    if not user:
        return jsonify({'success': False, 'error': 'User not found'}), 404
    
    return jsonify({'success': True, 'user': user})

@app.route('/api/users/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    data = request.json
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
    
    user = db.update_user(user_id, data)
    if not user:
        return jsonify({'success': False, 'error': 'User not found'}), 404
    db.add_audit_event(get_actor(), 'Updated user', 'user', user_id, {'username': user.get('username')})
    
    socketio.emit('user_updated', user)
    return jsonify({'success': True, 'user': user})

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    success = db.delete_user(user_id)
    if not success:
        return jsonify({'success': False, 'error': 'User not found'}), 404
    db.add_audit_event(get_actor(), 'Removed user', 'user', user_id)
    
    socketio.emit('user_deleted', {'user_id': user_id})
    return jsonify({'success': True})

# AI Simulator Control
@app.route('/api/ai/start', methods=['POST'])
def start_ai():
    ai_simulator.start()
    return jsonify({'success': True, 'message': 'AI Simulator started'})

@app.route('/api/ai/stop', methods=['POST'])
def stop_ai():
    ai_simulator.stop()
    return jsonify({'success': True, 'message': 'AI Simulator stopped'})

@app.route('/api/ai/status', methods=['GET'])
def ai_status():
    return jsonify({
        'success': True,
        'running': ai_simulator.running
    })

# ============ VIDEO RECORDING ============

recording_sessions = {}

@app.route('/api/recordings/<int:camera_id>/start', methods=['POST'])
def start_recording(camera_id):
    data = request.get_json() or {}
    camera_name = data.get('camera_name', f'Camera {camera_id}')
    
    if camera_id in recording_sessions:
        return jsonify({'success': False, 'error': 'Recording already in progress'}), 400
    
    started_at = datetime.now()
    recording_sessions[camera_id] = {
        'camera_id': camera_id,
        'camera_name': camera_name,
        'started_at': started_at.isoformat(),
        'status': 'recording'
    }
    
    socketio.emit('recording_started', {
        'camera_id': camera_id,
        'camera_name': camera_name,
        'timestamp': started_at.isoformat()
    })
    
    return jsonify({
        'success': True,
        'message': f'Recording started for {camera_name}',
        'session': recording_sessions[camera_id]
    })

@app.route('/api/recordings/<int:camera_id>/stop', methods=['POST'])
def stop_recording(camera_id):
    if camera_id not in recording_sessions:
        return jsonify({'success': False, 'error': 'No active recording'}), 400
    
    session = recording_sessions.pop(camera_id)
    stopped_at = datetime.now()
    camera_name = session.get('camera_name', f'Camera {camera_id}')
    started_at_str = session.get('started_at')
    
    # Create recording metadata
    try:
        started_at = datetime.fromisoformat(started_at_str)
        duration = (stopped_at - started_at).total_seconds()
    except:
        duration = 0
    
    recording = db.add_recording({
        'camera_id': camera_id,
        'camera_name': camera_name,
        'filename': f'recording_cam{camera_id}_{stopped_at.strftime("%Y%m%d_%H%M%S")}.mp4',
        'duration': duration,
        'started_at': started_at_str,
        'stopped_at': stopped_at.isoformat(),
        'size_mb': 0
    })

    alarm_wall = db.get_settings()
    if alarm_wall.get('alarm_wall_enabled'):
        recordings_dir = os.path.join(os.path.dirname(__file__), '..', 'recordings')

        def deliver_clip():
            try:
                result = send_clip(alarm_wall, recording, recordings_dir)
                socketio.emit('alarm_wall_delivery', {'success': True, 'recording_id': recording['id'], **result})
            except Exception as exc:
                socketio.emit('alarm_wall_delivery', {'success': False, 'recording_id': recording['id'], 'error': str(exc)})

        threading.Thread(target=deliver_clip, daemon=True).start()
    
    socketio.emit('recording_stopped', {
        'camera_id': camera_id,
        'camera_name': camera_name,
        'timestamp': stopped_at.isoformat(),
        'recording': recording
    })
    
    return jsonify({
        'success': True,
        'message': f'Recording stopped for {camera_name}',
        'recording': recording
    })

@app.route('/api/recordings', methods=['GET'])
def get_recordings():
    camera_id = request.args.get('camera_id', type=int)
    if camera_id:
        recordings = db.get_recordings_by_camera(camera_id)
    else:
        recordings = db.get_all_recordings()
    
    # Sort by created_at descending
    recordings = sorted(recordings, key=lambda r: r.get('created_at', ''), reverse=True)
    
    return jsonify({
        'success': True,
        'recordings': recordings
    })

@app.route('/api/recordings/<int:recording_id>', methods=['GET'])
def get_recording(recording_id):
    recording = db.get_recording(recording_id)
    if not recording:
        return jsonify({'success': False, 'error': 'Recording not found'}), 404
    
    return jsonify({
        'success': True,
        'recording': recording
    })

@app.route('/api/recordings/<int:recording_id>', methods=['DELETE'])
def delete_recording(recording_id):
    if not db.delete_recording(recording_id):
        return jsonify({'success': False, 'error': 'Recording not found'}), 404
    
    return jsonify({
        'success': True,
        'message': 'Recording deleted'
    })

@app.route('/api/recordings/<int:recording_id>/archive', methods=['POST'])
def archive_recording(recording_id):
    if not db.archive_recording(recording_id):
        return jsonify({'success': False, 'error': 'Recording not found'}), 404
    
    return jsonify({
        'success': True,
        'message': 'Recording archived'
    })

@app.route('/api/recordings/status', methods=['GET'])
def get_recordings_status():
    return jsonify({
        'success': True,
        'active_recordings': recording_sessions
    })


@app.route('/api/audit/events', methods=['GET'])
def get_audit_events():
    limit = request.args.get('limit', 365, type=int)
    events = db.get_audit_events(limit=limit)
    return jsonify({'success': True, 'events': events})

@app.route('/api/analytics/summary', methods=['GET'])
def analytics_summary():
    audit_limit = request.args.get('audit_limit', 50, type=int)
    cameras = db.get_all_cameras()
    alerts = db.get_alerts(limit=10000, acknowledged=True)
    recordings = db.get_all_recordings()

    total_cameras = len(cameras)
    offline_cameras = [c for c in cameras if c.get('status') == 'offline']

    # Alarms per camera grouped by requested interval
    alarm_interval = request.args.get('alarm_interval', 'day')
    if alarm_interval not in {'minute', 'hour', 'day', 'week'}:
        alarm_interval = 'day'

    def build_alarm_buckets(interval):
        now = datetime.utcnow()
        buckets = []
        labels = []

        if interval == 'minute':
            current = now.replace(second=0, microsecond=0)
            for i in range(59, -1, -1):
                start = current - timedelta(minutes=i)
                buckets.append((start, start + timedelta(minutes=1)))
                labels.append(start.strftime('%H:%M'))
        elif interval == 'hour':
            current = now.replace(minute=0, second=0, microsecond=0)
            for i in range(23, -1, -1):
                start = current - timedelta(hours=i)
                buckets.append((start, start + timedelta(hours=1)))
                labels.append(start.strftime('%Hh'))
        elif interval == 'week':
            current = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
            for i in range(6, -1, -1):
                start = current - timedelta(weeks=i)
                buckets.append((start, start + timedelta(weeks=1)))
                labels.append(start.strftime('%b %d'))
        else:
            current = now.replace(hour=0, minute=0, second=0, microsecond=0)
            for i in range(6, -1, -1):
                start = current - timedelta(days=i)
                buckets.append((start, start + timedelta(days=1)))
                labels.append(start.strftime('%a'))

        return buckets, labels

    alarm_buckets, alarm_trend_labels = build_alarm_buckets(alarm_interval)
    alarms_per_camera = {}
    bucket_counts = {}

    for a in alerts:
        ts = a.get('timestamp')
        if not ts:
            continue
        try:
            event_dt = datetime.fromisoformat(ts)
        except ValueError:
            try:
                event_dt = datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S')
            except Exception:
                try:
                    event_dt = datetime.strptime(ts[:10], '%Y-%m-%d')
                except Exception:
                    continue
        if event_dt < alarm_buckets[0][0] or event_dt >= alarm_buckets[-1][1]:
            continue

        cam_id = a.get('camera_id')
        alarms_per_camera[cam_id] = alarms_per_camera.get(cam_id, 0) + 1
        if cam_id not in bucket_counts:
            bucket_counts[cam_id] = [0] * len(alarm_buckets)

        for index, (start, end) in enumerate(alarm_buckets):
            if start <= event_dt < end:
                bucket_counts[cam_id][index] += 1
                break

    alarm_trends = []
    camera_names = {c.get('id'): c.get('name', f'Camera {c.get("id")}') for c in cameras}
    for cam_id in sorted(camera_names.keys(), key=lambda k: -(alarms_per_camera.get(k, 0))):
        alarm_trends.append({
            'camera_id': cam_id,
            'name': camera_names.get(cam_id, f'Camera {cam_id}'),
            'counts': bucket_counts.get(cam_id, [0] * len(alarm_buckets)),
            'total': alarms_per_camera.get(cam_id, 0)
        })

    # Most detected subject today
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)
    today_cutoff = today_start.isoformat()
    yesterday_cutoff = yesterday_start.isoformat()
    
    # Only count detections from configured rules
    allowed_detection_objects = ['human', 'car']
    
    # Today's detection data with hourly breakdown
    subject_counts = {}
    subject_hourly = {}  # {subject: [hour0_count, hour1_count, ...]}
    
    for a in alerts:
        ts = a.get('timestamp')
        if not ts or ts < today_cutoff:
            continue
        obj = a.get('object_detected') or a.get('object') or 'unknown'
        
        # Only count detections from allowed rules
        if obj not in allowed_detection_objects:
            continue
        
        subject_counts[obj] = subject_counts.get(obj, 0) + 1
        
        # Track hourly breakdown
        try:
            event_dt = datetime.fromisoformat(ts)
        except (ValueError, TypeError):
            try:
                event_dt = datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S')
            except Exception:
                continue
        
        hour = event_dt.hour
        if obj not in subject_hourly:
            subject_hourly[obj] = [0] * 24
        subject_hourly[obj][hour] += 1
    
    # Yesterday's detection data for comparison
    yesterday_counts = {}
    for a in alerts:
        ts = a.get('timestamp')
        if not ts or ts < yesterday_cutoff or ts >= today_cutoff:
            continue
        obj = a.get('object_detected') or a.get('object') or 'unknown'
        
        # Only count detections from allowed rules
        if obj not in allowed_detection_objects:
            continue
        
        yesterday_counts[obj] = yesterday_counts.get(obj, 0) + 1

    most_detected = None
    if subject_counts:
        most_detected = max(subject_counts.items(), key=lambda x: x[1])
    
    # Provide full breakdown of detected subjects for today's analytics with comparisons
    detected_subjects_today = sorted(
        [{'subject': k, 
          'count': v,
          'yesterday_count': yesterday_counts.get(k, 0),
          'trend': 'up' if v > yesterday_counts.get(k, 0) else ('down' if v < yesterday_counts.get(k, 0) else 'stable'),
          'hourly_breakdown': subject_hourly.get(k, [0]*24),
          'peak_hour': subject_hourly.get(k, [0]*24).index(max(subject_hourly.get(k, [0]*24))) if subject_hourly.get(k) else 0
         } for k, v in subject_counts.items()],
        key=lambda x: -x['count']
    )

    # Recording status per camera (last recording time)
    recordings_by_camera = {}
    for r in recordings:
        cid = r.get('camera_id')
        recordings_by_camera.setdefault(cid, []).append(r)

    last_recording = {cid: sorted(lst, key=lambda r: r.get('created_at', ''), reverse=True)[0]
                      for cid, lst in recordings_by_camera.items()}

    # Cameras added (id, name, added_at)
    cameras_added = [{'id': c.get('id'), 'name': c.get('name'), 'added_at': c.get('added_at')} for c in cameras]

    # Offline cameras with last seen from connection events when available
    offline_list = []
    for c in offline_cameras:
        latest = db.get_latest_connection_event(c.get('id'))
        last_seen = None
        if latest:
            last_seen = latest.get('timestamp')
        else:
            last_seen = c.get('updated_at') or c.get('added_at')
        offline_list.append({
            'id': c.get('id'),
            'name': c.get('name'),
            'last_seen': last_seen
        })

    return jsonify({
        'success': True,
        'total_cameras': total_cameras,
        'offline_count': len(offline_cameras),
        'alarms_per_camera': alarms_per_camera,
        'alarm_trend_labels': alarm_trend_labels,
        'alarm_trends': alarm_trends,
        'most_detected_today': {'subject': most_detected[0], 'count': most_detected[1]} if most_detected else None,
        'detected_subjects_today': detected_subjects_today,
        'last_recording': {cid: rec for cid, rec in last_recording.items()},
        'cameras': cameras_added,
        'offline_cameras': offline_list,
        'audit_events': db.get_audit_events(limit=audit_limit)
    })

@app.route('/api/cameras/<int:camera_id>/connection-events', methods=['GET'])
def get_camera_connection_events(camera_id):
    limit = request.args.get('limit', 100, type=int)
    events = db.get_connection_events(camera_id=camera_id, limit=limit)
    return jsonify({'success': True, 'events': events})

@app.route('/api/cameras/<int:camera_id>/connection-event', methods=['POST'])
def log_camera_connection_event(camera_id):
    data = request.get_json() or {}
    status = data.get('status')
    if status not in ('online', 'offline'):
        return jsonify({'success': False, 'error': 'Invalid status. Use "online" or "offline".'}), 400
    timestamp = data.get('timestamp')
    camera = db.get_camera(camera_id)
    if not camera:
        return jsonify({'success': False, 'error': 'Camera not found'}), 404
    event = db.add_connection_event(camera_id, status, timestamp)
    db.update_camera(camera_id, {'status': status}, log_event=False)
    try:
        socketio.emit('camera_connection_event', {'camera': camera, 'event': event})
    except Exception:
        pass
    return jsonify({'success': True, 'event': event})

@app.route('/api/recordings/config', methods=['GET'])
def get_recordings_config():
    config = db.get_recordings_config()
    return jsonify({
        'success': True,
        'config': config
    })

@app.route('/api/recordings/config', methods=['POST'])
def update_recordings_config():
    data = request.get_json() or {}
    config = db.update_recordings_config(data)
    db.add_audit_event(get_actor(), 'Updated recording settings', 'recordings')
    
    socketio.emit('recordings_config_updated', config)
    
    return jsonify({
        'success': True,
        'config': config,
        'message': 'Recordings configuration updated'
    })

@app.route('/api/recordings/cleanup', methods=['POST'])
def cleanup_recordings():
    result = db.cleanup_old_recordings()
    
    socketio.emit('recordings_cleanup_completed', result)
    
    return jsonify({
        'success': True,
        **result
    })

@app.route('/<path:path>')
def serve_static(path):
    if path.startswith('api/') or path.startswith('recordings/') or path.startswith('logo/'):
        return jsonify({'success': False, 'error': 'Not found'}), 404
    return send_from_directory('../frontend', path)

# ============ AI SIMULATOR CALLBACK ============

def on_new_alert(alert):
    """Callback when AI simulator generates a new alert"""
    socketio.emit('new_alert', alert)
    # Update stats
    stats = db.get_alert_stats()
    socketio.emit('stats_update', stats)

# Register callback
ai_simulator.register_filter(lambda detection: db.get_effective_schedule_state().get('mode') != 'disarmed')
ai_simulator.register_callback(on_new_alert)

# ============ MAIN ============

if __name__ == '__main__':
    if platform.system().lower() == 'linux' and os.geteuid() != 0:
        raise SystemExit('TEMPEST X must be started as root on Ubuntu/Linux. Use sudo.')

    # Start AI simulator by default
    ai_simulator.start()
    
    # Run Flask app with SocketIO
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)