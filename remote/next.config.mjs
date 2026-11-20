/** @type {import('next').NextConfig} */
export default {
  // The page shows a village's builders: never cached by a proxy, never framed.
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Referrer-Policy', value: 'no-referrer' }] }];
  },
};
