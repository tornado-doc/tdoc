const assert = require('node:assert/strict');
const { socialVideo } = require('../shell/src/document/social-video.mjs');

const reel = socialVideo('https://www.instagram.com/p/DKBWtrNx557/?utm_source=ignored');
assert.equal(reel.embed, 'https://www.instagram.com/p/DKBWtrNx557/embed/');
const tiktok = socialVideo('https://www.tiktok.com/@sharongambu/video/7688029830398496020?ignored=1');
assert.equal(tiktok.embed, 'https://www.tiktok.com/player/v1/7688029830398496020?autoplay=1&muted=1&rel=0');
const youtube = socialVideo('https://www.youtube.com/watch?v=Ajt-3C4VEHc&t=431s');
assert.equal(youtube.embed, 'https://www.youtube.com/embed/Ajt-3C4VEHc?playsinline=1&autoplay=1&rel=0&start=431');
assert.equal(socialVideo('https://www.linkedin.com/posts/example-video-1').embed, undefined);

for (const href of [
  'https://www.instagram.com.attacker.example/p/DKBWtrNx557/',
  'https://name@www.instagram.com/p/DKBWtrNx557/',
  'https://www.instagram.com:8080/p/DKBWtrNx557/',
  'http://www.instagram.com/p/DKBWtrNx557/',
  'https://www.instagram.com/accounts/login/',
  'https://www.tiktok.com/@creator/video/7688029830398496020/extra',
  'https://www.youtube.com/watch?v=Ajt-3C4VEHc%2f',
  'javascript:alert(1)',
]) assert.equal(socialVideo(href), null, href);
console.log('  ✓ Video URLs are reconstructed from approved hosts and post identifiers');
