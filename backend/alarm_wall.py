"""XML-over-TCP delivery for finalized motion clips."""

import base64
import os
import socket
import xml.etree.ElementTree as ET
from datetime import datetime


def _text(value):
    return '' if value is None else str(value)


def build_clip_message(recording, device_id, clip_path=None, include_clip=True):
    root = ET.Element('tempest_x_motion_clip', {'version': '1.0'})
    ET.SubElement(root, 'device_id').text = _text(device_id)
    ET.SubElement(root, 'event_type').text = 'motion_clip'
    ET.SubElement(root, 'sent_at').text = datetime.now().astimezone().isoformat()
    clip = ET.SubElement(root, 'clip')
    for key in ('id', 'camera_id', 'camera_name', 'filename', 'started_at', 'stopped_at', 'duration', 'size_mb'):
        ET.SubElement(clip, key).text = _text(recording.get(key))

    file_exists = bool(clip_path and os.path.isfile(clip_path))
    ET.SubElement(clip, 'content_encoding').text = 'base64' if include_clip and file_exists else 'none'
    if include_clip and file_exists:
        with open(clip_path, 'rb') as clip_file:
            ET.SubElement(clip, 'content').text = base64.b64encode(clip_file.read()).decode('ascii')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True) + b'\n'


def send_xml(host, port, payload, timeout=10):
    with socket.create_connection((host, int(port)), timeout=max(1, int(timeout))) as connection:
        connection.sendall(payload)


def send_clip(config, recording, recordings_dir):
    host = (config.get('alarm_wall_host') or '').strip()
    if not host:
        raise ValueError('Alarm Wall host is required')
    clip_path = os.path.join(recordings_dir, recording.get('filename', ''))
    payload = build_clip_message(
        recording,
        config.get('alarm_wall_device_id') or config.get('device_id', ''),
        clip_path=clip_path,
        include_clip=config.get('alarm_wall_include_clip', True),
    )
    send_xml(host, config.get('alarm_wall_port', 9100), payload, config.get('alarm_wall_timeout', 10))
    return {'bytes_sent': len(payload), 'host': host, 'port': int(config.get('alarm_wall_port', 9100))}