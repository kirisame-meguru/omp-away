"""Routing state belongs to the broker, never to an individual desktop writer."""
from pathlib import Path

from .identity import read_private_json, write_private_json
from .transport import ProtocolError


def patch_preferences(current: dict, patch: object) -> dict:
    if not isinstance(patch, dict) or not patch.keys() <= {'away', 'delayMs'}:
        raise ProtocolError('invalid routing patch')
    if 'away' in patch and type(patch['away']) is not bool:
        raise ProtocolError('invalid away mode')
    if 'delayMs' in patch:
        delay = patch['delayMs']
        if delay is not None and (type(delay) is not int or not 0 <= delay <= 2147483647):
            raise ProtocolError('invalid fallback delay')
    return {**current, **patch}


def load_preferences(directory: Path) -> dict:
    try:
        value = read_private_json(directory / 'routing.json', 4096)
    except FileNotFoundError:
        return {'away': False, 'delayMs': None}
    if not isinstance(value, dict) or value.keys() != {'away', 'delayMs'}:
        raise ProtocolError('invalid routing preferences')
    return patch_preferences({}, value)


def save_preferences(directory: Path, preferences: dict) -> None:
    write_private_json(directory / 'routing.json', preferences)
