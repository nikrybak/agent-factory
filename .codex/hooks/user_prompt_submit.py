#!/usr/bin/env python3
import json
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

text = json.dumps(payload, ensure_ascii=False).lower()
if any(key in text for key in ['архитект', 'architecture', 'module', 'модуль', 'api', 'database', 'db']):
    print('ROUTING HINT: This likely needs `/app-arch-required` and an ADR check.')
if any(key in text for key in [
    'атак', 'attack', 'чит', 'cheat', 'античит', 'anti-cheat', 'anti-tamper', 'антитампер', 'тампер',
    'взлом', 'эксплойт', 'exploit', 'red team', 'red-team', 'nrg shield', 'nrg-shield', 'nrg-attest',
    'frida', 'xposed', 'lsposed', 'owasp masvs', 'проверка безопасн', 'проверить безопасн',
    'безопасность прилож', 'безопасность игр', 'игра безопасн', 'приложение безопасн',
]):
    print('ROUTING HINT: To verify an app/game against attacks or run the security check, use the '
          'nrg-shield-red-team skill (runner: app_entry_root/packages/nrg-shield/tools/attack-battery.sh, '
          'table: app_entry_root/packages/nrg-shield/docs/SECURITY-CHECK.md).')
sys.exit(0)
