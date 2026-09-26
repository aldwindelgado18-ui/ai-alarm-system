import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend.ai_simulator import AISimulator


class AISimulatorTests(unittest.TestCase):
    def setUp(self):
        self.simulator = AISimulator()
        self.detection = {
            'camera_id': 1,
            'camera_name': 'Test Camera',
            'object_detected': 'human',
            'zone': 'Zone 1',
            'confidence': 69,
            'confidence_threshold': 70,
            'type': 'detection',
        }

    @patch('backend.ai_simulator.db.add_alert')
    def test_confidence_threshold_is_applied_before_persisting(self, add_alert):
        self.simulator._trigger_alert(self.detection)
        add_alert.assert_not_called()

        self.detection['confidence'] = 70
        add_alert.return_value = {**self.detection, 'id': 1}
        self.simulator._trigger_alert(self.detection)
        add_alert.assert_called_once()

    @patch('backend.ai_simulator.db.add_alert')
    def test_filter_runs_before_persisting(self, add_alert):
        self.simulator.register_filter(lambda detection: False)
        self.simulator._trigger_alert({**self.detection, 'confidence': 90})
        add_alert.assert_not_called()


if __name__ == '__main__':
    unittest.main()
