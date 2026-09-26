import os
import shutil
import tempfile
import unittest
from datetime import datetime

from backend.database import Database


class ScheduleConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix='tempest-schedule-', dir='c:/ai-alarm-portal')
        self.db = Database()
        self.db.base_dir = self.temp_dir
        self.db.backend_dir = os.path.join(self.temp_dir, 'backend')
        self.db.cameras_file = os.path.join(self.temp_dir, 'camera_data.json')
        self.db.alerts_file = os.path.join(self.temp_dir, 'alerts_log.json')
        self.db.users_file = os.path.join(self.temp_dir, 'users.json')
        self.db.settings_file = os.path.join(self.temp_dir, 'settings.json')
        os.makedirs(self.db.backend_dir, exist_ok=True)
        self.db._initialize_files()

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_schedule_config_persists_and_holiday_override_wins(self):
        schedule_config = {
            'enabled': True,
            'default_mode': 'disarmed',
            'timezone': 'UTC',
            'schedules': [
                {
                    'id': 1,
                    'name': 'Night Watch',
                    'days': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
                    'start': '18:00',
                    'end': '06:00',
                    'mode': 'armed',
                }
            ],
            'holiday_overrides': [
                {
                    'id': 101,
                    'name': 'Holiday Monitoring',
                    'date': '2026-12-25',
                    'mode': 'armed',
                    'notes': 'Override for holiday monitoring',
                }
            ],
        }

        saved = self.db.update_schedule_config(schedule_config)
        self.assertEqual(saved['default_mode'], 'disarmed')
        self.assertEqual(saved['schedules'][0]['mode'], 'armed')

        effective = self.db.get_effective_schedule_state(datetime(2026, 12, 25, 8, 0))
        self.assertEqual(effective['mode'], 'armed')
        self.assertEqual(effective['source'], 'holiday_override')

    def test_timezone_config_uses_configured_timezone(self):
        schedule_config = {
            'enabled': True,
            'default_mode': 'disarmed',
            'timezone': 'America/Los_Angeles',
            'schedules': [
                {
                    'id': 2,
                    'name': 'Evening Shift',
                    'days': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
                    'start': '20:00',
                    'end': '23:59',
                    'mode': 'armed',
                }
            ],
            'holiday_overrides': [],
        }

        self.db.update_schedule_config(schedule_config)
        effective = self.db.get_effective_schedule_state(datetime(2026, 7, 2, 22, 30))
        self.assertEqual(effective['mode'], 'armed')
        self.assertEqual(effective['source'], 'schedule')

    def test_manual_override_precedence(self):
        schedule_config = {
            'enabled': True,
            'default_mode': 'disarmed',
            'timezone': 'UTC',
            'schedules': [
                {
                    'id': 3,
                    'name': 'Day Guard',
                    'days': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
                    'start': '08:00',
                    'end': '18:00',
                    'mode': 'armed',
                }
            ],
            'holiday_overrides': []
        }

        self.db.update_schedule_config(schedule_config)
        self.db.set_manual_override({'mode': 'disarmed', 'set_at': datetime(2026, 7, 2, 12, 0).isoformat()})

        effective = self.db.get_effective_schedule_state(datetime(2026, 7, 2, 12, 30))
        self.assertEqual(effective['mode'], 'disarmed')
        self.assertEqual(effective['source'], 'manual_override')

    def test_schedule_times_are_normalized_to_military_format(self):
        schedule_config = {
            'enabled': True,
            'default_mode': 'disarmed',
            'default_time': '8:00',
            'timezone': 'UTC',
            'schedules': [
                {
                    'id': 4,
                    'name': 'Morning Guard',
                    'days': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
                    'start': '8:00',
                    'end': '20:00',
                    'mode': 'armed',
                }
            ],
            'holiday_overrides': []
        }

        saved = self.db.update_schedule_config(schedule_config)

        self.assertEqual(saved['default_time'], '08:00')
        self.assertEqual(saved['schedules'][0]['start'], '08:00')
        self.assertEqual(saved['schedules'][0]['end'], '20:00')

    def test_system_export_import_roundtrip(self):
        # Seed some sample data
        cameras = [
            {'id': 1, 'name': 'Front Door', 'location': 'Entrance', 'ip': '192.168.1.10', 'added_at': datetime.now().isoformat()}
        ]
        alerts = [
            {'id': 1, 'camera_id': 1, 'camera_name': 'Front Door', 'type': 'motion', 'object_detected': 'human', 'zone': 'Doorway', 'confidence': 90, 'timestamp': datetime.now().isoformat(), 'acknowledged': False}
        ]
        users = [
            {'id': 1, 'username': 'superadmin', 'email': 'superadmin@tempestx.local', 'role': 'super_admin', 'password_hash': 'tempestx', 'status': 'active', 'created_at': datetime.now().isoformat(), 'last_login': None}
        ]

        self.db._save_json(self.db.cameras_file, {'cameras': cameras, 'next_id': 2})
        self.db._save_json(self.db.alerts_file, {'alerts': alerts, 'acknowledged': []})
        self.db._save_json(self.db.users_file, {'users': users, 'next_id': 2})

        export_payload = self.db.get_system_export()
        self.assertEqual(export_payload['cameras'], cameras)
        self.assertEqual(export_payload['alerts'], alerts)
        self.assertEqual(export_payload['users'], users)
        self.assertIn('settings', export_payload)

        # Modify files and then re-import
        modified_payload = export_payload.copy()
        modified_payload['cameras'] = []
        modified_payload['alerts'] = []
        modified_payload['users'] = []
        self.db.import_system_config(modified_payload)

        loaded_cameras = self.db._load_json(self.db.cameras_file)
        loaded_alerts = self.db._load_json(self.db.alerts_file)
        loaded_users = self.db._load_json(self.db.users_file)
        self.assertEqual(loaded_cameras['cameras'], [])
        self.assertEqual(loaded_alerts['alerts'], [])
        self.assertEqual(loaded_users['users'], [])


if __name__ == '__main__':
    unittest.main()
