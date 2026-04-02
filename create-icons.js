const { createCanvas } = require('canvas');
const fs = require('fs');

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Фон
  ctx.fillStyle = '#4299e1';
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
  ctx.fill();

  // Щит
  ctx.fillStyle = 'white';
  ctx.font = `bold ${size * 0.55}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🛡', size/2, size/2);

  return canvas.toBuffer('image/png');
}

[16, 48, 128].forEach(size => {
  fs.writeFileSync(`icons/icon${size}.png`, createIcon(size));
  console.log(`Created icon${size}.png`);
});
