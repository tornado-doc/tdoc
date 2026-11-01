// Private renderer process. The CLI accepts files only after checking native warnings.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
try {
  const { svg, fonts, widths, out } = JSON.parse(fs.readFileSync(0, 'utf8'));
  // Inline HTML SVGs omit the namespace; add it for standalone XML parsing.
  const standalone = svg.replace(/<svg(?=[\s>])([^>]*)>/, (tag, attrs) => /\bxmlns\s*=/.test(attrs) ? tag : `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>`);
  const images = [];
  for (const width of widths) {
    const renderer = new Resvg(standalone, {
      background: 'white', fitTo: { mode: 'width', value: width }, logLevel: 'warn',
      font: { fontFiles: fonts, loadSystemFonts: false },
    });
    const height = Math.ceil(renderer.height * width / renderer.width);
    if (!Number.isFinite(height) || height < 1 || width * height > 8_000_000) throw new Error('Preview exceeds the 8 megapixel limit.');
    const name = `${width}.png`;
    fs.writeFileSync(path.join(out, name), renderer.render().asPng());
    images.push(name);
  }
  console.log(JSON.stringify({ images }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
