"""Rebuild the original tiny test fonts with fontTools; not used at test runtime."""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

for name, chars in [('Latin', ' A'), ('CJK', ' 中文')]:
    fb = FontBuilder(1000, isTTF=True)
    glyphs = ['.notdef'] + ['u%04X' % ord(c) for c in chars]
    fb.setupGlyphOrder(glyphs)
    fb.setupCharacterMap({ord(c): glyphs[i + 1] for i, c in enumerate(chars)})
    shapes = {}
    for glyph in glyphs:
        pen = TTGlyphPen(None)
        if glyph != 'u0020':
            pen.moveTo((50, 0)); pen.lineTo((550, 0))
            pen.lineTo((550, 700)); pen.lineTo((50, 700)); pen.closePath()
        shapes[glyph] = pen.glyph()
    fb.setupGlyf(shapes)
    fb.setupHorizontalMetrics({g: (600, 0) for g in glyphs})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': 'Preview ' + name, 'styleName': 'Regular',
                      'uniqueFontIdentifier': 'tdoc-preview-' + name,
                      'fullName': 'Preview ' + name, 'psName': 'Preview-' + name})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost(); fb.setupMaxp()
    fb.save(Path(__file__).with_name(name.lower() + '.ttf'))
