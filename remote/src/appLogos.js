// App icons, keyed by Android package: one PNG per app in ./app-logos/, named <package>.png.
// To add one, drop the app's square icon in that folder under its package name and rebuild.
// Apps with no icon here fall back to a tile in the app's colour with its name.
const files = import.meta.glob('./app-logos/*.png', { eager: true, query: '?url', import: 'default' });

const byPackage = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.replace('./app-logos/', '').replace(/\.png$/, ''), url]),
);

export const logoFor = (app) => (app?.package ? byPackage[app.package] : undefined);
