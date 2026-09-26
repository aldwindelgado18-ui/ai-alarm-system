import json
import os
import shutil
import threading
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Dict, List, Optional
from urllib.parse import urlsplit


def camera_host_from_rtsp(rtsp_url: str) -> str:
    """Return the host portion of an RTSP URL, excluding credentials and port."""
    if not rtsp_url:
        return ''
    try:
        parsed = urlsplit(str(rtsp_url).strip())
        return parsed.hostname or ''
    except ValueError:
        return ''

class Database:
    def __init__(self):
        self.base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        self.backend_dir = os.path.join(self.base_dir, 'backend')
        self.cameras_file = os.path.join(self.base_dir, 'camera_data.json')
        self.alerts_file = os.path.join(self.base_dir, 'alerts_log.json')
        self.users_file = os.path.join(self.base_dir, 'users.json')
        self.settings_file = os.path.join(self.base_dir, 'settings.json')
        self.recordings_file = os.path.join(self.base_dir, 'recordings.json')
        self.connection_events_file = os.path.join(self.base_dir, 'connection_events.json')
        self.audit_file = os.path.join(self.base_dir, 'audit_log.json')
        self._lock = threading.RLock()
        self._migrate_legacy_files()
        self._initialize_files()

    def _migrate_legacy_files(self):
        """Copy existing JSON files from the backend folder into the workspace root when needed."""
        legacy_files = {
            'camera_data.json': self.cameras_file,
            'alerts_log.json': self.alerts_file,
            'users.json': self.users_file,
            'settings.json': self.settings_file,
        }

        for legacy_name, target_path in legacy_files.items():
            legacy_path = os.path.join(self.backend_dir, legacy_name)
            if os.path.exists(legacy_path) and (not os.path.exists(target_path) or os.path.getsize(target_path) == 0):
                shutil.copy2(legacy_path, target_path)

    def _initialize_files(self):
        """Initialize JSON files if they don't exist"""
        if not os.path.exists(self.cameras_file):
            self._save_json(self.cameras_file, {
                'cameras': [],
                'next_id': 1
            })
        
        if not os.path.exists(self.alerts_file):
            self._save_json(self.alerts_file, {
                'alerts': [],
                'acknowledged': []
            })
        
        if not os.path.exists(self.users_file):
            self._save_json(self.users_file, {
                'users': [
                    {
                        'id': 1,
                        'username': 'superadmin',
                        'email': 'superadmin@tempestx.local',
                        'role': 'super_admin',
                        'password_hash': 'tempestx',
                        'status': 'active',
                        'created_at': datetime.now().isoformat(),
                        'last_login': None
                    },
                    {
                        'id': 2,
                        'username': 'admin',
                        'email': 'admin@tempestx.local',
                        'role': 'admin',
                        'password_hash': 'admin123',
                        'status': 'active',
                        'created_at': datetime.now().isoformat(),
                        'last_login': None
                    },
                    {
                        'id': 3,
                        'username': 'operator',
                        'email': 'operator@tempestx.local',
                        'role': 'operator',
                        'password_hash': 'operator123',
                        'status': 'active',
                        'created_at': datetime.now().isoformat(),
                        'last_login': None
                    }
                ],
                'next_id': 4
            })
        
        if not os.path.exists(self.settings_file):
            self._save_json(self.settings_file, {
                'alarm_integration': {
                    'site_name': '',
                    'site_id': '',
                    'server': '',
                    'port': 2525,
                    'sender': '',
                    'receiver': '',
                    'alarm_wall_enabled': False,
                    'alarm_wall_host': '',
                    'alarm_wall_port': 9100,
                    'alarm_wall_device_id': '',
                    'alarm_wall_include_clip': True,
                    'alarm_wall_timeout': 10
                },
                'network_settings': {
                    'mode': 'dhcp',
                    'dhcp_hostname': '',
                    'static_ip': '',
                    'static_subnet': '',
                    'static_gateway': '',
                    'static_dns': ''
                },
                'schedule_config': {
                    'enabled': True,
                    'default_mode': 'disarmed',
                    'schedules': [],
                    'holiday_overrides': [],
                    'manual_override': None
                },
                'recordings_config': {
                    'retention_days': 30,
                    'auto_cleanup_enabled': True
                }
            })

        if not os.path.exists(self.recordings_file):
            self._save_json(self.recordings_file, {
                'recordings': [],
                'next_id': 1
            })

        if not os.path.exists(self.connection_events_file):
            self._save_json(self.connection_events_file, {
                'events': [],
                'next_id': 1
            })

        if not os.path.exists(self.audit_file):
            self._save_json(self.audit_file, {
                'events': [],
                'next_id': 1
            })

    def _load_json(self, filename: str) -> dict:
        """Load JSON data from file"""
        with self._lock:
            try:
                with open(filename, 'r') as f:
                    return json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                return {}

    def _save_json(self, filename: str, data: dict) -> None:
        """Save JSON data to file"""
        with self._lock:
            with open(filename, 'w') as f:
                json.dump(data, f, indent=2)

    def add_audit_event(self, actor: str, action: str, entity: str, entity_id=None, details: Optional[Dict] = None) -> Dict:
        data = self._load_json(self.audit_file)
        event = {
            'id': data.get('next_id', 1),
            'actor': actor or 'System',
            'action': action,
            'entity': entity,
            'entity_id': entity_id,
            'details': details or {},
            'timestamp': datetime.now().isoformat()
        }
        data.setdefault('events', []).append(event)
        data['next_id'] = event['id'] + 1
        self._save_json(self.audit_file, data)
        return event

    def get_audit_events(self, limit: int = 50) -> List[Dict]:
        data = self._load_json(self.audit_file)
        events = data.get('events', []) if isinstance(data, dict) else []
        return sorted(events, key=lambda event: event.get('timestamp', ''), reverse=True)[:limit]

    # ============ CAMERA OPERATIONS ============
    
    def add_camera(self, camera_data: Dict) -> Dict:
        """Add a new camera"""
        data = self._load_json(self.cameras_file)
        cameras = data.get('cameras', [])
        if len(cameras) >= 20:
            raise ValueError('Maximum of 20 cameras reached')
        camera_id = data['next_id']
        rtsp_url = camera_data.get('rtsp_url', '')
        rtsp_host = camera_host_from_rtsp(rtsp_url)
        
        camera = {
            'id': camera_id,
            'name': camera_data.get('name', f'Camera {camera_id}'),
            'location': camera_data.get('location', 'Unknown'),
            'ip': rtsp_host or camera_data.get('ip', ''),
            'manufacturer': camera_data.get('manufacturer', 'Generic'),
            'connection_type': camera_data.get('connection_type', 'RTSP'),
            'rtsp_url': rtsp_url,
            'rtsp_username': camera_data.get('rtsp_username', ''),
            'rtsp_password': camera_data.get('rtsp_password', ''),
            'onvif_url': camera_data.get('onvif_url', ''),
            'status': 'online',
            'detection_enabled': True,
            'confidence_threshold': camera_data.get('confidence_threshold', 70),
            'zones': camera_data.get('zones', []),
            'object_types': camera_data.get('object_types', ['human', 'car']),
            'privacy_masks': camera_data.get('privacy_masks', []),
            'alarm_actions': camera_data.get('alarm_actions', ['push', 'email']),
            'added_at': datetime.now().isoformat()
        }
        
        data['cameras'].append(camera)
        data['next_id'] += 1
        self._save_json(self.cameras_file, data)
        # Log initial connection event as 'online' when camera is added
        try:
            self.add_connection_event(camera['id'], 'online', camera.get('added_at'))
        except Exception:
            pass
        return camera

    def get_all_cameras(self) -> List[Dict]:
        """Get all cameras"""
        data = self._load_json(self.cameras_file)
        cameras = data.get('cameras', [])
        changed = False
        for camera in cameras:
            rtsp_host = camera_host_from_rtsp(camera.get('rtsp_url', ''))
            if rtsp_host and camera.get('ip') != rtsp_host:
                camera['ip'] = rtsp_host
                changed = True
        if changed:
            self._save_json(self.cameras_file, data)
        return cameras

    def get_camera(self, camera_id: int) -> Optional[Dict]:
        """Get a single camera by ID"""
        cameras = self.get_all_cameras()
        for camera in cameras:
            if camera['id'] == camera_id:
                return camera
        return None

    def update_camera(self, camera_id: int, update_data: Dict, log_event: bool = True) -> Optional[Dict]:
        """Update camera settings"""
        data = self._load_json(self.cameras_file)
        cameras = data['cameras']
        
        for i, camera in enumerate(cameras):
            if camera['id'] == camera_id:
                old_status = camera.get('status')
                cameras[i].update(update_data)
                rtsp_host = camera_host_from_rtsp(cameras[i].get('rtsp_url', ''))
                if rtsp_host:
                    cameras[i]['ip'] = rtsp_host
                cameras[i]['updated_at'] = datetime.now().isoformat()
                self._save_json(self.cameras_file, data)
                new_status = cameras[i].get('status')
                try:
                    if log_event and 'status' in update_data and new_status != old_status:
                        self.add_connection_event(camera_id, new_status)
                except Exception:
                    pass
                return cameras[i]
        return None

    # ============ CONNECTION EVENTS ============
    def add_connection_event(self, camera_id: int, status: str, timestamp: Optional[str] = None) -> Dict:
        """Log a camera connection event (online/offline)"""
        data = self._load_json(self.connection_events_file)
        events = data.get('events', [])
        event_id = data.get('next_id', 1)

        event = {
            'id': event_id,
            'camera_id': camera_id,
            'status': status,
            'timestamp': timestamp or datetime.now().isoformat()
        }

        events.append(event)
        data['events'] = events
        data['next_id'] = event_id + 1
        self._save_json(self.connection_events_file, data)
        return event

    def get_connection_events(self, camera_id: Optional[int] = None, limit: int = 100) -> List[Dict]:
        data = self._load_json(self.connection_events_file)
        events = data.get('events', [])
        if camera_id is not None:
            events = [e for e in events if e.get('camera_id') == camera_id]
        events = sorted(events, key=lambda x: x.get('timestamp', ''), reverse=True)
        return events[:limit]

    def get_latest_connection_event(self, camera_id: int) -> Optional[Dict]:
        ev = self.get_connection_events(camera_id=camera_id, limit=1)
        return ev[0] if ev else None

    def delete_camera(self, camera_id: int) -> bool:
        """Delete a camera"""
        data = self._load_json(self.cameras_file)
        cameras = data['cameras']
        
        for i, camera in enumerate(cameras):
            if camera['id'] == camera_id:
                del cameras[i]
                self._save_json(self.cameras_file, data)
                return True
        return False

    # ============ ALERT OPERATIONS ============
    
    def add_alert(self, alert_data: Dict) -> Dict:
        """Add a new alert"""
        data = self._load_json(self.alerts_file)
        alerts = data.get('alerts', []) if isinstance(data, dict) else []
        data = data if isinstance(data, dict) else {}
        data.setdefault('alerts', [])
        data.setdefault('acknowledged', [])

        alert = {
            'id': len(alerts) + 1,
            'camera_id': alert_data.get('camera_id'),
            'camera_name': alert_data.get('camera_name', 'Unknown'),
            'type': alert_data.get('type', 'detection'),
            'object_detected': alert_data.get('object_detected', 'human'),
            'zone': alert_data.get('zone', 'Zone 1'),
            'confidence': alert_data.get('confidence', 85),
            'timestamp': datetime.now().isoformat(),
            'acknowledged': False,
            'acknowledged_by': None,
            'acknowledged_at': None,
            'snapshot': alert_data.get('snapshot', None)
        }

        data['alerts'].append(alert)
        self._save_json(self.alerts_file, data)
        return alert

    def get_alerts(self, limit: int = 50, acknowledged: bool = False) -> List[Dict]:
        """Get alerts with optional filters"""
        data = self._load_json(self.alerts_file)
        alerts = data.get('alerts', []) if isinstance(data, dict) else []
        
        if not acknowledged:
            alerts = [a for a in alerts if not a.get('acknowledged', False)]
        
        # Return most recent first
        alerts = sorted(alerts, key=lambda x: x.get('timestamp', ''), reverse=True)
        return alerts[:limit]

    def acknowledge_alert(self, alert_id: int, user: str) -> Optional[Dict]:
        """Acknowledge an alert"""
        data = self._load_json(self.alerts_file)
        alerts = data['alerts']
        
        for alert in alerts:
            if alert['id'] == alert_id:
                alert['acknowledged'] = True
                alert['acknowledged_by'] = user
                alert['acknowledged_at'] = datetime.now().isoformat()
                self._save_json(self.alerts_file, data)
                return alert
        return None

    def get_alert_stats(self) -> Dict:
        """Get alert statistics"""
        data = self._load_json(self.alerts_file)
        alerts = data['alerts']
        users_data = self._load_json(self.users_file)
        users = users_data.get('users', [])
        
        today = datetime.now().date()
        today_alerts = [a for a in alerts if datetime.fromisoformat(a['timestamp']).date() == today]
        
        total = len(alerts)
        acknowledged = len([a for a in alerts if a.get('acknowledged', False)])
        unacknowledged = total - acknowledged
        today_count = len(today_alerts)
        active_users = len([u for u in users if u.get('status') == 'active'])
        
        return {
            'total_alerts': total,
            'acknowledged': acknowledged,
            'unacknowledged': unacknowledged,
            'today_count': today_count,
            'processing_alerts': unacknowledged,
            'acknowledged_alerts': acknowledged,
            'users_processing_alerts': active_users
        }

    # ============ USER OPERATIONS ============
    
    def create_user(self, user_data: Dict) -> Dict:
        """Create a new user account"""
        data = self._load_json(self.users_file)
        user_id = data['next_id']
        
        user = {
            'id': user_id,
            'username': user_data.get('username'),
            'email': user_data.get('email'),
            'role': user_data.get('role', 'operator'),
            'password_hash': user_data.get('password_hash', user_data.get('password')),
            'status': 'active',
            'created_at': datetime.now().isoformat(),
            'last_login': None
        }
        
        data['users'].append(user)
        data['next_id'] += 1
        self._save_json(self.users_file, data)
        return user

    def get_all_users(self) -> List[Dict]:
        """Get all users"""
        data = self._load_json(self.users_file)
        users = data.get('users', [])
        # Don't return password hashes in list
        return [
            {k: v for k, v in u.items() if k != 'password_hash'}
            for u in users
        ]

    def get_user(self, user_id: int) -> Optional[Dict]:
        """Get a single user by ID"""
        data = self._load_json(self.users_file)
        users = data.get('users', [])
        for user in users:
            if user['id'] == user_id:
                return {k: v for k, v in user.items() if k != 'password_hash'}
        return None

    def get_user_by_username(self, username: str) -> Optional[Dict]:
        """Get a user by username"""
        data = self._load_json(self.users_file)
        users = data.get('users', [])
        for user in users:
            if user['username'] == username:
                return user
        return None

    def update_user(self, user_id: int, update_data: Dict) -> Optional[Dict]:
        """Update user information"""
        data = self._load_json(self.users_file)
        users = data['users']
        
        for i, user in enumerate(users):
            if user['id'] == user_id:
                # Don't allow password_hash update via this method
                update_data.pop('password_hash', None)
                update_data.pop('password', None)
                users[i].update(update_data)
                self._save_json(self.users_file, data)
                return {k: v for k, v in users[i].items() if k != 'password_hash'}
        return None

    def delete_user(self, user_id: int) -> bool:
        """Delete a user account"""
        data = self._load_json(self.users_file)
        users = data['users']
        
        for i, user in enumerate(users):
            if user['id'] == user_id:
                del users[i]
                self._save_json(self.users_file, data)
                return True
        return False

    def verify_login(self, username: str, password: str) -> Optional[Dict]:
        """Verify user login credentials"""
        user = self.get_user_by_username(username)
        if user and user.get('password_hash') == password and user.get('status') == 'active':
            # Update last login
            data = self._load_json(self.users_file)
            for u in data['users']:
                if u['id'] == user['id']:
                    u['last_login'] = datetime.now().isoformat()
                    self._save_json(self.users_file, data)
                    break
            return {k: v for k, v in user.items() if k != 'password_hash'}
        return None

    # ===== SETTINGS OPERATIONS =====
    def get_settings(self) -> dict:
        data = self._load_json(self.settings_file)
        return data.get('alarm_integration', {})

    def get_network_settings(self) -> dict:
        data = self._load_json(self.settings_file)
        defaults = {
            'mode': 'dhcp',
            'dhcp_hostname': '',
            'static_ip': '',
            'static_subnet': '',
            'static_gateway': '',
            'static_dns': ''
        }
        network_settings = data.get('network_settings', {})
        return {**defaults, **network_settings}

    def update_network_settings(self, settings_data: Dict) -> dict:
        data = self._load_json(self.settings_file)
        network_settings = data.get('network_settings', {})
        network_settings.update({
            'mode': settings_data.get('mode', network_settings.get('mode', 'dhcp')),
            'dhcp_hostname': settings_data.get('dhcp_hostname', network_settings.get('dhcp_hostname', '')),
            'static_ip': settings_data.get('static_ip', network_settings.get('static_ip', '')),
            'static_subnet': settings_data.get('static_subnet', network_settings.get('static_subnet', '')),
            'static_gateway': settings_data.get('static_gateway', network_settings.get('static_gateway', '')),
            'static_dns': settings_data.get('static_dns', network_settings.get('static_dns', ''))
        })
        data['network_settings'] = network_settings
        self._save_json(self.settings_file, data)
        return self.get_network_settings()

    def _normalize_days(self, days: Optional[List[str]]) -> List[str]:
        if not days:
            return []
        mapping = {
            'sun': 'Sun', 'sunday': 'Sun',
            'mon': 'Mon', 'monday': 'Mon',
            'tue': 'Tue', 'tuesday': 'Tue',
            'wed': 'Wed', 'wednesday': 'Wed',
            'thu': 'Thu', 'thursday': 'Thu',
            'fri': 'Fri', 'friday': 'Fri',
            'sat': 'Sat', 'saturday': 'Sat',
        }
        day_order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        normalized = []
        for day in days:
            if isinstance(day, str):
                cleaned = day.strip().lower()
                # Handle day ranges like "Monday-Friday" or "Mon-Fri"
                if '-' in cleaned:
                    parts = cleaned.split('-')
                    if len(parts) == 2:
                        start_day = parts[0].strip()
                        end_day = parts[1].strip()
                        start_mapped = mapping.get(start_day)
                        end_mapped = mapping.get(end_day)
                        if start_mapped and end_mapped:
                            start_idx = day_order.index(start_mapped) if start_mapped in day_order else -1
                            end_idx = day_order.index(end_mapped) if end_mapped in day_order else -1
                            if start_idx != -1 and end_idx != -1:
                                if start_idx <= end_idx:
                                    for i in range(start_idx, end_idx + 1):
                                        if day_order[i] not in normalized:
                                            normalized.append(day_order[i])
                                else:
                                    # Wrap around (e.g., Fri-Mon)
                                    for i in range(start_idx, len(day_order)):
                                        if day_order[i] not in normalized:
                                            normalized.append(day_order[i])
                                    for i in range(0, end_idx + 1):
                                        if day_order[i] not in normalized:
                                            normalized.append(day_order[i])
                else:
                    # Single day
                    if cleaned in mapping:
                        if mapping[cleaned] not in normalized:
                            normalized.append(mapping[cleaned])
                    elif cleaned in mapping.values():
                        if cleaned not in normalized:
                            normalized.append(cleaned)
        return normalized

    def _normalize_time_value(self, time_value: Optional[str]) -> str:
        if not time_value:
            return '00:00'
        if not isinstance(time_value, str):
            return '00:00'

        text = time_value.strip()
        if not text:
            return '00:00'

        if ':' not in text:
            return '00:00'

        try:
            hours, minutes = text.split(':', 1)
            hours_int = int(hours)
            minutes_int = int(minutes)
        except ValueError:
            return '00:00'

        hours_int = max(0, min(hours_int, 23))
        minutes_int = max(0, min(minutes_int, 59))
        return f'{hours_int:02d}:{minutes_int:02d}'

    def _time_to_minutes(self, time_value: str) -> int:
        normalized = self._normalize_time_value(time_value)
        try:
            hours, minutes = normalized.split(':', 1)
            return int(hours) * 60 + int(minutes)
        except ValueError:
            return 0

    def _is_time_in_window(self, current_time, start: str, end: str) -> bool:
        current_minutes = current_time.hour * 60 + current_time.minute
        start_minutes = self._time_to_minutes(start)
        end_minutes = self._time_to_minutes(end)
        if start_minutes <= end_minutes:
            return start_minutes <= current_minutes <= end_minutes
        return current_minutes >= start_minutes or current_minutes <= end_minutes

    def get_schedule_config(self) -> dict:
        data = self._load_json(self.settings_file)
        schedule_config = data.get('schedule_config', {})
        return {
            'enabled': schedule_config.get('enabled', True),
            'default_profile': schedule_config.get('default_profile', 'default'),
            'default_mode': schedule_config.get('default_mode', 'disarmed'),
            'default_days': schedule_config.get('default_days', 'weekdays'),
            'default_time': schedule_config.get('default_time', '08:00'),
            'timezone': schedule_config.get('timezone', 'UTC'),
            'schedules': schedule_config.get('schedules', []),
            'holiday_overrides': schedule_config.get('holiday_overrides', []),
            'manual_override': schedule_config.get('manual_override')
        }

    def update_schedule_config(self, schedule_data: Dict) -> dict:
        data = self._load_json(self.settings_file)
        existing = data.get('schedule_config', {})
        manual_override = existing.get('manual_override')
        if 'manual_override' in schedule_data:
            manual_override = schedule_data.get('manual_override')

        normalized_schedules = []
        for schedule in schedule_data.get('schedules', []):
            normalized_schedule = dict(schedule)
            normalized_schedule['start'] = self._normalize_time_value(schedule.get('start'))
            normalized_schedule['end'] = self._normalize_time_value(schedule.get('end'))
            normalized_schedules.append(normalized_schedule)

        schedule_config = {
            'enabled': bool(schedule_data.get('enabled', True)),
            'default_profile': schedule_data.get('default_profile', 'default'),
            'default_mode': schedule_data.get('default_mode', 'disarmed'),
            'default_days': schedule_data.get('default_days', 'weekdays'),
            'default_time': self._normalize_time_value(schedule_data.get('default_time', '08:00')),
            'timezone': schedule_data.get('timezone', 'UTC'),
            'schedules': normalized_schedules,
            'holiday_overrides': schedule_data.get('holiday_overrides', []),
            'manual_override': manual_override
        }
        # Create a backup of existing schedule before overwriting
        try:
            existing = data.get('schedule_config')
            if existing:
                backup_path = os.path.join(self.backend_dir, 'schedule_backup.json')
                with open(backup_path, 'w') as bf:
                    json.dump(existing, bf, indent=2)
        except Exception:
            pass

        data['schedule_config'] = schedule_config
        self._save_json(self.settings_file, data)
        return schedule_config

    def get_schedule_backup(self) -> Optional[Dict]:
        backup_path = os.path.join(self.backend_dir, 'schedule_backup.json')
        try:
            with open(backup_path, 'r') as bf:
                return json.load(bf)
        except Exception:
            return None

    def restore_schedule_from_backup(self) -> Optional[Dict]:
        backup = self.get_schedule_backup()
        if not backup:
            return None
        data = self._load_json(self.settings_file)
        data['schedule_config'] = backup
        self._save_json(self.settings_file, data)
        return backup

    def set_manual_override(self, override: Optional[Dict]) -> dict:
        data = self._load_json(self.settings_file)
        schedule_config = data.get('schedule_config', {})
        schedule_config['manual_override'] = override
        data['schedule_config'] = schedule_config
        self._save_json(self.settings_file, data)
        return self.get_schedule_config()

    def get_effective_schedule_state(self, reference_time: Optional[datetime] = None) -> dict:
        config = self.get_schedule_config()
        manual_override = config.get('manual_override')
        if manual_override and manual_override.get('mode') in ('armed', 'disarmed'):
            return {
                'mode': manual_override.get('mode'),
                'source': 'manual_override',
                'reason': 'Manual override set',
                'manual_override': manual_override
            }

        if not config.get('enabled', True):
            return {
                'mode': config.get('default_mode', 'disarmed'),
                'source': 'disabled',
                'reason': 'Scheduling disabled'
            }

        now = reference_time or datetime.now()
        timezone_name = config.get('timezone', 'UTC')
        try:
            tz = ZoneInfo(timezone_name)
            now_in_tz = now.astimezone(tz) if now.tzinfo else now.replace(tzinfo=tz)
        except Exception:
            now_in_tz = now

        date_key = now_in_tz.strftime('%Y-%m-%d')
        day_name = now_in_tz.strftime('%a')

        for override in config.get('holiday_overrides', []):
            if override.get('date') == date_key:
                return {
                    'mode': override.get('mode', 'armed'),
                    'source': 'holiday_override',
                    'reason': override.get('name') or 'Holiday override active',
                    'date': date_key
                }

        for schedule in config.get('schedules', []):
            days = self._normalize_days(schedule.get('days', []))
            if days and day_name not in days:
                continue
            if self._is_time_in_window(now_in_tz, schedule.get('start', '00:00'), schedule.get('end', '23:59')):
                return {
                    'mode': schedule.get('mode', 'armed'),
                    'source': 'schedule',
                    'reason': schedule.get('name') or 'Schedule active',
                    'schedule_name': schedule.get('name')
                }

        return {
            'mode': config.get('default_mode', 'disarmed'),
            'source': 'default',
            'reason': 'No schedule matched; default mode applied'
        }

    def update_settings(self, settings_data: Dict) -> dict:
        data = self._load_json(self.settings_file)
        alarm_integration = data.get('alarm_integration', {})
        alarm_integration.update({
            'device_id': settings_data.get('device_id', alarm_integration.get('device_id', '')),
            'smtp_server': settings_data.get('smtp_server', alarm_integration.get('smtp_server', '')),
            'smtp_port': int(settings_data.get('smtp_port', alarm_integration.get('smtp_port', 2525))),
            'recipient_domain': settings_data.get('recipient_domain', alarm_integration.get('recipient_domain', '')),
            'sender': settings_data.get('sender', alarm_integration.get('sender', '')),
            'password': settings_data.get('password', alarm_integration.get('password', '')),
            'security': settings_data.get('security', alarm_integration.get('security', 'none')),
            'detected_event_type': settings_data.get('detected_event_type', alarm_integration.get('detected_event_type', 'snapshot')),
            'disappeared_event_type': settings_data.get('disappeared_event_type', alarm_integration.get('disappeared_event_type', 'none'))
        })
        alarm_integration.update({
            'alarm_wall_enabled': bool(settings_data.get('alarm_wall_enabled', alarm_integration.get('alarm_wall_enabled', False))),
            'alarm_wall_host': settings_data.get('alarm_wall_host', alarm_integration.get('alarm_wall_host', '')),
            'alarm_wall_port': int(settings_data.get('alarm_wall_port', alarm_integration.get('alarm_wall_port', 9100))),
            'alarm_wall_device_id': settings_data.get('alarm_wall_device_id', alarm_integration.get('alarm_wall_device_id', '')),
            'alarm_wall_include_clip': bool(settings_data.get('alarm_wall_include_clip', alarm_integration.get('alarm_wall_include_clip', True))),
            'alarm_wall_timeout': int(settings_data.get('alarm_wall_timeout', alarm_integration.get('alarm_wall_timeout', 10)))
        })
        data['alarm_integration'] = alarm_integration
        self._save_json(self.settings_file, data)
        return alarm_integration

    def get_system_export(self) -> dict:
        cameras = self._load_json(self.cameras_file)
        alerts = self._load_json(self.alerts_file)
        users = self._load_json(self.users_file)
        settings = self._load_json(self.settings_file)
        return {
            'cameras': cameras.get('cameras', []),
            'camera_next_id': cameras.get('next_id', 1),
            'alerts': alerts.get('alerts', []),
            'acknowledged': alerts.get('acknowledged', []),
            'users': users.get('users', []),
            'users_next_id': users.get('next_id', 1),
            'settings': settings
        }

    def import_system_config(self, config: Dict) -> dict:
        if not isinstance(config, dict):
            raise ValueError('Import payload must be an object')

        if 'cameras' in config or 'camera_next_id' in config:
            cameras_payload = {
                'cameras': config.get('cameras', []),
                'next_id': config.get('camera_next_id', max((cam.get('id', 0) for cam in config.get('cameras', [])), default=0) + 1)
            }
            self._save_json(self.cameras_file, cameras_payload)

        if 'alerts' in config or 'acknowledged' in config:
            alerts_payload = {
                'alerts': config.get('alerts', []),
                'acknowledged': config.get('acknowledged', [])
            }
            self._save_json(self.alerts_file, alerts_payload)

        if 'users' in config or 'users_next_id' in config:
            users_payload = {
                'users': config.get('users', []),
                'next_id': config.get('users_next_id', max((user.get('id', 0) for user in config.get('users', [])), default=0) + 1)
            }
            self._save_json(self.users_file, users_payload)

        if 'settings' in config:
            settings_payload = config.get('settings', {})
            if isinstance(settings_payload, dict):
                self._save_json(self.settings_file, settings_payload)

        return self.get_system_export()

    # ============ RECORDING OPERATIONS ============

    def add_recording(self, recording_data: Dict) -> Dict:
        """Add a new recording"""
        data = self._load_json(self.recordings_file)
        recording_id = data.get('next_id', 1)
        
        recording = {
            'id': recording_id,
            'camera_id': recording_data.get('camera_id'),
            'camera_name': recording_data.get('camera_name'),
            'filename': recording_data.get('filename', f'recording_{recording_id}.mp4'),
            'duration': recording_data.get('duration', 0),
            'size_mb': recording_data.get('size_mb', 0),
            'started_at': recording_data.get('started_at'),
            'stopped_at': recording_data.get('stopped_at'),
            'created_at': datetime.now().isoformat(),
            'archived': False,
            'notes': recording_data.get('notes', '')
        }
        
        data['recordings'].append(recording)
        data['next_id'] = recording_id + 1
        self._save_json(self.recordings_file, data)
        return recording

    def get_all_recordings(self) -> List[Dict]:
        """Get all recordings"""
        data = self._load_json(self.recordings_file)
        return data.get('recordings', [])

    def get_recordings_by_camera(self, camera_id: int) -> List[Dict]:
        """Get recordings for a specific camera"""
        data = self._load_json(self.recordings_file)
        return [r for r in data.get('recordings', []) if r.get('camera_id') == camera_id]

    def delete_recording(self, recording_id: int) -> bool:
        """Delete a recording"""
        data = self._load_json(self.recordings_file)
        original_count = len(data.get('recordings', []))
        data['recordings'] = [r for r in data.get('recordings', []) if r.get('id') != recording_id]
        
        if len(data['recordings']) < original_count:
            self._save_json(self.recordings_file, data)
            return True
        return False

    def archive_recording(self, recording_id: int) -> bool:
        """Archive a recording"""
        data = self._load_json(self.recordings_file)
        for recording in data.get('recordings', []):
            if recording.get('id') == recording_id:
                recording['archived'] = True
                self._save_json(self.recordings_file, data)
                return True
        return False

    def get_recording(self, recording_id: int) -> Optional[Dict]:
        """Get a specific recording"""
        data = self._load_json(self.recordings_file)
        for recording in data.get('recordings', []):
            if recording.get('id') == recording_id:
                return recording
        return None

    def get_recordings_config(self) -> dict:
        """Get recordings retention configuration"""
        data = self._load_json(self.settings_file)
        recordings_config = data.get('recordings_config', {})
        return {
            'retention_days': recordings_config.get('retention_days', 30),
            'auto_cleanup_enabled': recordings_config.get('auto_cleanup_enabled', True)
        }

    def update_recordings_config(self, config_data: Dict) -> dict:
        """Update recordings retention configuration"""
        data = self._load_json(self.settings_file)
        recordings_config = {
            'retention_days': config_data.get('retention_days', 30),
            'auto_cleanup_enabled': config_data.get('auto_cleanup_enabled', True)
        }
        data['recordings_config'] = recordings_config
        self._save_json(self.settings_file, data)
        return recordings_config

    def cleanup_old_recordings(self) -> Dict:
        """Delete recordings older than retention days"""
        config = self.get_recordings_config()
        retention_days = config.get('retention_days', 30)
        
        if retention_days <= 0 or not config.get('auto_cleanup_enabled', True):
            return {'deleted': 0, 'message': 'Cleanup disabled or invalid retention days'}
        
        data = self._load_json(self.recordings_file)
        now = datetime.now()
        deleted_count = 0
        deleted_ids = []
        
        recordings = data.get('recordings', [])
        filtered_recordings = []
        
        for recording in recordings:
            try:
                created_at = datetime.fromisoformat(recording.get('created_at', ''))
                age_days = (now - created_at).days
                
                if age_days > retention_days and not recording.get('archived', False):
                    deleted_count += 1
                    deleted_ids.append(recording.get('id'))
                    # Try to delete the file
                    try:
                        filename = recording.get('filename')
                        if filename:
                            file_path = os.path.join(self.base_dir, 'recordings', filename)
                            if os.path.exists(file_path):
                                os.remove(file_path)
                    except Exception as e:
                        print(f"Could not delete file: {e}")
                else:
                    filtered_recordings.append(recording)
            except Exception as e:
                print(f"Error processing recording: {e}")
                filtered_recordings.append(recording)
        
        data['recordings'] = filtered_recordings
        self._save_json(self.recordings_file, data)
        
        return {
            'deleted': deleted_count,
            'deleted_ids': deleted_ids,
            'message': f'Deleted {deleted_count} recordings older than {retention_days} days'
        }

# ============ DATA STORE ============
db = Database()