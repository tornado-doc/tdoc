These tiny synthetic fonts are original test fixtures under the repository license,
not copies or subsets of system fonts. Latin maps space and A; CJK maps space,
中 and 文. Visible glyphs deliberately use simple rectangles: these tests assert
coverage/fallback diagnostics, not typography or visual quality. This makes
missing-glyph tests independent of the machine's installed fonts.

To regenerate, run generate.py with a development Python containing fontTools.
CI uses the committed TTF files and needs neither Python packages nor font downloads.
