import('../../../frontend/lib/criteria.mjs').then((m) => {
  const e000 = String.fromCodePoint(0xe000);
  const u10000 = String.fromCodePoint(0x10000);
  const nb = '{"' + e000 + '":"1","' + u10000 + '":"2"}';
  const canon = m.canonicalizeCriteria(nb);
  console.log('nonBMP-canon:', canon);
  console.log('nonBMP-canon-esc:', JSON.stringify(canon));
  console.log('u10000-first:', canon.indexOf(u10000) < canon.indexOf(e000));
});
