const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="18%" cy="0%" r="120%">
      <stop offset="0%" stop-color="#1c2233"/>
      <stop offset="55%" stop-color="#0d0f14"/>
      <stop offset="100%" stop-color="#08090c"/>
    </radialGradient>
    <radialGradient id="ember" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#c06d22" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#c06d22" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1080" cy="60" r="420" fill="url(#ember)"/>
  <text x="88" y="150" font-family="Helvetica, Arial, sans-serif" font-size="22" letter-spacing="8" fill="#f0a868">INDEPENDENT CREATIVE STUDIO</text>
  <text x="84" y="300" font-family="Georgia, Times New Roman, serif" font-size="120" fill="#f2f4f8">Games. Books.</text>
  <text x="84" y="430" font-family="Georgia, Times New Roman, serif" font-size="120" fill="#f0a868">Art.</text>
  <rect x="88" y="500" width="80" height="2" fill="#363d4b"/>
  <text x="88" y="560" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#a8b0c0">dlartcompany.com</text>
</svg>`;

const { default: sharp } = await import('sharp');
await sharp(Buffer.from(svg)).png().toFile('public/og.png');
console.log('Wrote public/og.png');
