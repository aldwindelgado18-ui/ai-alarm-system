import random
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional
from database import db

class AISimulator:
    """Simulates AI detection on camera feeds"""
    
    def __init__(self):
        self.running = False
        self.thread = None
        self.stop_event = threading.Event()
        self.callbacks = []
        self.filters = []
        self.allowed_detection_objects = ['human', 'car']
        self.zones = ['Zone 1 - Entrance', 'Zone 2 - Perimeter', 'Zone 3 - Parking', 'Zone 4 - Loading Dock']
        
    def start(self):
        """Start the AI simulation thread"""
        if self.running:
            return
        self.running = True
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        print("AI Simulator started")
        
    def stop(self):
        """Stop the AI simulation"""
        self.running = False
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
        print("AI Simulator stopped")
    
    def _run(self):
        """Main simulation loop"""
        while self.running:
            try:
                # Get all cameras
                cameras = db.get_all_cameras()
                
                for camera in cameras:
                    if not camera.get('detection_enabled', True):
                        continue
                    
                    # Randomly generate detections (30% chance per cycle)
                    if random.random() < 0.3:
                        # Generate detection
                        detection = self._generate_detection(camera)
                        if detection:
                            self._trigger_alert(detection)
                settings = db.get_settings()
                try:
                    interval = max(1, int(settings.get('detection_interval', 10)))
                except (TypeError, ValueError):
                    interval = 10
                self.stop_event.wait(interval)
            except Exception as e:
                print(f"AI Simulator error: {e}")
                time.sleep(5)
    
    def _generate_detection(self, camera: Dict) -> Optional[Dict]:
        """Generate a simulated detection event"""
        # If camera has zones, use them; otherwise use default
        zones = camera.get('zones', self.zones)
        if not zones:
            zones = self.zones
        zones = [zone.get('name') if isinstance(zone, dict) else zone for zone in zones]
            
        # Randomly determine if this should be an alert
        # 40% chance of generating an alert
        if random.random() < 0.6:
            return None
            
        # Determine if it's a false positive (15% chance)
        is_false_positive = random.random() < 0.15
        
        # Generate confidence based on detection quality
        base_confidence = random.randint(65, 95)
        if is_false_positive:
            confidence = random.randint(30, 64)  # Low confidence = false positive
            object_detected = random.choice(['shadow', 'leaf', 'insect', 'bird'])
        else:
            confidence = base_confidence
            object_detected = random.choice(self.allowed_detection_objects)
        
        return {
            'camera_id': camera['id'],
            'camera_name': camera['name'],
            'object_detected': object_detected,
            'zone': random.choice(zones),
            'confidence': confidence,
            'confidence_threshold': camera.get('confidence_threshold', 70),
            'type': 'detection'
        }
    
    def _trigger_alert(self, detection: Dict):
        """Process and store an alert"""
        try:
            threshold = int(detection.get('confidence_threshold', 70))
        except (TypeError, ValueError):
            threshold = 70
        if detection['confidence'] < max(0, min(100, threshold)):
            return

        if any(not detection_filter(detection) for detection_filter in self.filters):
            return
            
        # Create alert
        alert = db.add_alert(detection)
        
        # Notify callbacks
        for callback in self.callbacks:
            try:
                callback(alert)
            except Exception as e:
                print(f"Callback error: {e}")
        
        print(f"ALERT: {alert['camera_name']} - {alert['object_detected']} @ {alert['zone']} (conf: {alert['confidence']}%)")
    
    def register_callback(self, callback):
        """Register a callback for new alerts"""
        self.callbacks.append(callback)

    def register_filter(self, detection_filter):
        """Register a filter that must accept a detection before persistence."""
        self.filters.append(detection_filter)

# ============ GLOBAL AI SIMULATOR ============
ai_simulator = AISimulator()