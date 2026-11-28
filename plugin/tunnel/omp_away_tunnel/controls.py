"""Read-only encrypted metadata validation; no native answer values are accepted."""
from .transport import JSON_LIMIT, ProtocolError, encode
from .identity import ROUTE


def text(value, limit=8192):
    if not isinstance(value, str) or '\0' in value:
        return False
    try:
        # Match JavaScript/Kotlin string bounds, including astral Unicode.
        return len(value.encode('utf-16-le')) <= limit * 2
    except UnicodeError:
        return False


def question_display(display):
    if (not isinstance(display, dict) or display.keys() != {'v', 'context', 'fields'} or
            type(display['v']) is not int or display['v'] != 1 or not text(display['context']) or
            not isinstance(display['fields'], list) or not 1 <= len(display['fields']) <= 32):
        return False
    for index, field in enumerate(display['fields'], 1):
        required = {'id', 'label', 'kind', 'required'}
        optional = {'description', 'other', 'inputType', 'placeholder', 'options'}
        if (not isinstance(field, dict) or not required <= field.keys() or not field.keys() <= required | optional or
                field['id'] != f'f{index}' or not text(field['label']) or type(field['required']) is not bool or
                any(not text(field[key]) for key in ('description', 'inputType', 'placeholder') if key in field)):
            return False
        if field['kind'] == 'text':
            if 'options' in field or 'other' in field:
                return False
        elif field['kind'] in ('single', 'multi'):
            if ('inputType' in field or 'placeholder' in field or
                    'other' in field and type(field['other']) is not bool or
                    not isinstance(field.get('options'), list) or len(field['options']) > 256):
                return False
            for option_index, option in enumerate(field['options'], 1):
                if (not isinstance(option, dict) or option.keys() != {'id', 'label', 'disabled'} or
                        option['id'] != f'o{option_index}' or not text(option['label']) or type(option['disabled']) is not bool):
                    return False
        else:
            return False
    return len(encode(display)) <= 49152


def inbox_ids(message):
    if not isinstance(message, dict) or message.keys() != {'type', 'items'} or message['type'] != 'inbox' or not isinstance(message['items'], list):
        raise ProtocolError('invalid inbox')
    ids = set()
    for item in message['items']:
        required = {'requestId', 'project', 'question', 'createdAt'}
        if (not isinstance(item, dict) or not required <= item.keys() or not item.keys() <= required | {'session', 'call'} or
                not isinstance(item['requestId'], str) or ROUTE.fullmatch(item['requestId']) is None or item['requestId'] in ids or
                not text(item['project'], 128) or not text(item['question'], 256) or
                'session' in item and not text(item['session'], 128) or
                'call' in item and (not isinstance(item['call'], str) or ROUTE.fullmatch(item['call']) is None) or
                type(item['createdAt']) is not int or not 0 <= item['createdAt'] <= 2**53 - 1):
            raise ProtocolError('invalid inbox item')
        ids.add(item['requestId'])
    if len(encode(message)) > JSON_LIMIT:
        raise ProtocolError('inbox too large')
    return ids
