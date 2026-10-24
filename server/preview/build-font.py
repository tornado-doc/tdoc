#!/usr/bin/env python3
"""Rebuild the licensed preview fonts from the upstream Noto Sans SC variable TTF.

Usage: python3 -m pip install fonttools
       python3 server/preview/build-font.py /path/to/NotoSansSC[wght].ttf
"""
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib.instancer import instantiateVariableFont

source = Path(sys.argv[1])
out = Path(__file__).parent
chars = set(chr(code) for code in range(32, 127))
for high in list(range(0xA1, 0xAA)) + list(range(0xB0, 0xD8)):
    for low in range(0xA1, 0xFF):
        try:
            chars.add(bytes([high, low]).decode('gb2312'))
        except UnicodeDecodeError:
            pass
chars.update('，。！？：；（）【】《》“”‘’—…·✓→←•✦★')
for weight, label in [(400, 'Regular'), (700, 'Bold')]:
    font = TTFont(source)
    instantiateVariableFont(font, {'wght': weight}, inplace=True)
    opts = subset.Options()
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text=''.join(chars))
    subsetter.subset(font)
    for record in font['name'].names:
        names = {1: 'tdoc Preview CJK', 2: label,
                 4: 'tdoc Preview CJK ' + label, 6: 'tdocPreviewCJK-' + label}
        if record.nameID in names:
            record.string = names[record.nameID].encode('utf-16-be' if record.isUnicode() else 'ascii')
    font.save(out / f'NotoSansSC-{label}.ttf')
    if label == 'Regular':
        (out / 'coverage.json').write_text(json.dumps(sorted(font.getBestCmap()), separators=(',', ':')))
