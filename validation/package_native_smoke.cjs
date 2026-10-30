// Standalone release QA: relocate, install, optionally upgrade an older release, uninstall.
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.env.PHOTOALL_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const [portableSource, installer, previousInstaller] = process.argv.slice(2).map(p => path.resolve(p));
if (!portableSource || !installer) throw Error('Pass portable directory, NSIS installer and optional previous installer');
const output = path.join(__dirname, 'artifacts', 'package-native-' + Date.now());
fs.mkdirSync(output, {recursive: true});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'Photo All 独立发布 '));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PHOTOALL|PYTHON)/.test(key) && !/^path$/i.test(key)));
env.PATH = path.join(process.env.SystemRoot, 'System32');
env.APPDATA = path.join(temporary, 'profile', 'Roaming');
env.LOCALAPPDATA = path.join(temporary, 'profile', 'Local');
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Photo All Studio';
const settingsKey = 'HKCU\\Software\\photoall\\Photo All Studio';
// LOCALAPPDATA can be redirected by a sandbox; guard the real Windows user profile.
const protectedDatabase = path.join(os.homedir(), 'AppData', 'Local', 'org.photoall.studio', 'library.sqlite');
const databaseHash = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const protectedDatabaseBefore = databaseHash(protectedDatabase);
const run = (file, args, options = {}) => new Promise((resolve, reject) => {
  const process = spawn(file, args, {windowsHide: true, ...options});
  let stdout = '', stderr = '';
  process.stdout?.on('data', chunk => stdout += chunk);
  process.stderr?.on('data', chunk => stderr += chunk);
  process.once('error', reject);
  process.once('exit', code => code === 0 ? resolve({code, stdout, stderr}) : reject(Error(`${file} returned ${code}: ${stderr}`)));
});
const reg = path.join(process.env.SystemRoot, 'System32/reg.exe');
const existsKey = key => spawnSync(reg, ['query', key], {windowsHide: true, env, encoding: 'utf8'}).status === 0;
const waitFor = async (check, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Standalone native verification timed out');
};
let active, browser, installed = false;
const installedFolder = path.join(temporary, 'installed app');
const report = {temporary, portable: {}, installer: {}};
function copyDirectory(source, destination) {
  fs.mkdirSync(destination, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const input = path.join(source, entry.name), target = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(input, target);
    else fs.copyFileSync(input, target);
  }
}
async function exercise(executable, phase, port, expectedPhoto) {
  // Both installed versions deliberately share one isolated library for upgrade QA.
  const dataPhase = phase.startsWith('installed') ? 'installed' : phase;
  const data = path.join(temporary, 'profile', dataPhase, 'Local', 'org.photoall.studio');
  const appEnv = {...env, PHOTOALL_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: path.join(temporary, 'webview-' + phase),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`};
  fs.writeFileSync(path.join(output, phase + '-launch.json'), JSON.stringify({executable, exists: fs.existsSync(executable), cwd: temporary, cwd_exists: fs.existsSync(temporary)}, null, 2));
  active = spawn(executable, [], {cwd: temporary, env: appEnv, windowsHide: true});
  active.once('error', error => fs.writeFileSync(path.join(output, phase + '-spawn-error.txt'), String(error.stack)));
  let closed = false;
  active.once('exit', () => closed = true);
  active.stderr.on('data', chunk => fs.appendFileSync(path.join(output, phase + '-stderr.log'), chunk));
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.ok));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page;
  await waitFor(async () => {
    page = context.pages().find(p => p.url().includes('tauri.localhost'));
    return page && await page.evaluate(() => !!window.__TAURI_INTERNALS__);
  });
  const session = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('connection'));
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${session.port}/api${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw Error(`${route}: ${response.status}`);
    return response.json();
  };
  const before = (await api('/library')).photos;
  if (expectedPhoto) {
    if (before.length !== 1) throw Error('Upgrade did not preserve the isolated library');
    for (const field of ['id', 'path', 'digest', 'decision']) {
      if (before[0][field] !== expectedPhoto[field]) throw Error('Upgrade changed photo ' + field);
    }
    for (const [key, value] of Object.entries(expectedPhoto.recipe)) {
      if (JSON.stringify(before[0].recipe[key]) !== JSON.stringify(value)) throw Error('Upgrade changed recipe ' + key);
    }
    if (!fs.existsSync(before[0].path)) throw Error('Upgrade deleted the original photo');
  } else {
    if (before.length !== 0) throw Error('Isolated AppData profile is not empty');
    const fixture = path.join(temporary, phase + '.png');
    await run(path.join(path.dirname(executable), 'runtime/python/python.exe'), ['-c',
      "from PIL import Image; import sys; Image.new('RGB',(360,240),(73,129,173)).save(sys.argv[1])", fixture], {env: appEnv});
    const job = await api('/import', {paths: [fixture]});
    await waitFor(async () => (await api('/jobs/' + job.id)).status === 'done');
    const photos = (await api('/library')).photos;
    if (photos.length !== 1) throw Error('Imported photo missing');
    await api('/edit', {ids: [photos[0].id], recipe_patch: {exposure: 0.375, contrast: 1.125}, decision: 'keep'});
  }
  const preservedPhoto = (await api('/library')).photos[0];
  await page.reload();
  await page.getByRole('heading', {name: '图集', exact: true}).waitFor();
  let lighttableMotion = false;
  if (phase !== 'installed-before-upgrade') {
    const version = JSON.parse(fs.readFileSync(path.join(__dirname,'../product/package.json'),'utf8')).version;
    if (await page.locator('.version').textContent() !== version) throw Error('Bundled frontend version mismatch');
    const album = await api('/albums', {name:'独立安装动效验证'});
    const job = await api('/import', {paths:[preservedPhoto.path],album_id:album.id});
    await waitFor(async()=>(await api('/jobs/'+job.id)).status==='done');
    await page.reload();await page.getByRole('button',{name:'打开图集 独立安装动效验证'}).click();
    await page.getByRole('button',{name:'电子观片台',exact:true}).click();
    const table = page.locator('.film-table');
    await waitFor(async()=>await table.getAttribute('data-motion')==='idle');
    await page.mouse.move(700,5);await page.getByRole('button',{name:'一键收纳胶片'}).click();
    await waitFor(async()=>await table.getAttribute('data-motion')==='stowed');
    if (await page.getByText('照片已收纳到底部导览',{exact:true}).count() || await page.locator('.ft-table-caption').isVisible()) throw Error('Installed lighttable stow is not blank');
    await page.screenshot({path:path.join(output,phase+'-stowed.png')});
    await page.getByRole('button',{name:'一键平铺胶片'}).click();
    await waitFor(async()=>await table.getAttribute('data-motion')==='idle');
    await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'电子观片台'}).waitFor({state:'detached'});
    lighttableMotion = true;
  }
  await page.screenshot({path: path.join(output, phase + '.png')});
  const backend = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${active.pid}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
    {env, windowsHide: true, encoding: 'utf8'});
  if (backend.status !== 0) throw Error('Process inventory failed: ' + backend.stderr);
  const inventory = backend.stdout.trim();
  if (!inventory.includes('runtime') || /codex-runtimes|PHOTO ALL\\product/.test(inventory)) throw Error('Native process used the builder runtime: ' + inventory);
  fs.writeFileSync(path.join(output, phase + '-processes.json'), inventory);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label: 'main'})).catch(() => {});
  await waitFor(() => closed);
  let reachable = true;
  try { await api('/library'); } catch { reachable = false; }
  if (reachable) throw Error('Backend survived native close');
  if (!fs.existsSync(path.join(data, 'library.sqlite'))) throw Error('AppData library missing');
  await browser.close().catch(() => {});
  browser = undefined;
  active = undefined;
  return {native_started: true, authenticated_api: true, import: !expectedPhoto, isolated_appdata: true,
    bundled_interpreter: true, no_workspace_path: true, native_close: true, backend_cleanup: true,
    ...(expectedPhoto ? {upgrade_library_preserved: true, upgrade_recipe_preserved: true} : {}),
    lighttable_motion: lighttableMotion, photo: preservedPhoto};
}
(async () => {
  if (existsKey(uninstallKey) || existsKey(settingsKey)) throw Error('An existing user installation/profile registry entry must be preserved; test installation aborted');
  const portable = path.join(temporary, '便携 application');
  copyDirectory(portableSource, portable);
  report.portable = await exercise(path.join(portable, 'Photo All Studio.exe'), 'portable', 9438);
  const firstInstaller = previousInstaller || installer;
  const install = await run(firstInstaller, ['/S', '/NS', '/D=' + installedFolder], {env, windowsVerbatimArguments: true, argv0: '"' + firstInstaller + '"'});
  fs.writeFileSync(path.join(output, 'install-process.json'), JSON.stringify(install, null, 2));
  installed = true;
  if (!existsKey(uninstallKey) || !fs.existsSync(path.join(installedFolder, 'photo-all.exe'))) throw Error('Per-user installer did not register/install the application');
  report.installer = {per_user_registry: true, no_shortcuts: true,
    ...await exercise(path.join(installedFolder, 'photo-all.exe'), previousInstaller ? 'installed-before-upgrade' : 'installed', 9439)};
  if (previousInstaller) {
    const database = path.join(temporary, 'profile/installed/Local/org.photoall.studio/library.sqlite');
    const libraryHash = databaseHash(database);
    const upgrade = await run(installer, ['/S', '/NS', '/D=' + installedFolder], {env, windowsVerbatimArguments: true, argv0: '"' + installer + '"'});
    fs.writeFileSync(path.join(output, 'upgrade-process.json'), JSON.stringify(upgrade, null, 2));
    if (!fs.existsSync(database) || databaseHash(database) !== libraryHash) throw Error('Installer upgrade changed the library before launch');
    const version = spawnSync(reg, ['query', uninstallKey, '/v', 'DisplayVersion'], {env, windowsHide: true, encoding: 'utf8'});
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../product/package.json'), 'utf8')).version;
    if (version.status !== 0 || !version.stdout.includes(expectedVersion)) throw Error('Upgrade registry version mismatch: ' + version.stdout);
    report.upgrade = {previous_installer: previousInstaller, installer, version: expectedVersion,
      installer_preserved_library: true,
      ...await exercise(path.join(installedFolder, 'photo-all.exe'), 'installed-after-upgrade', 9440, report.installer.photo)};
  }
  const uninstaller = path.join(installedFolder, 'uninstall.exe');
  const uninstall = await run(uninstaller, ['/S', '_?=' + installedFolder], {env, windowsVerbatimArguments: true, argv0: '"' + uninstaller + '"'});
  fs.writeFileSync(path.join(output, 'uninstall-process.json'), JSON.stringify(uninstall, null, 2));
  await waitFor(() => !fs.existsSync(path.join(installedFolder, 'photo-all.exe')) && !existsKey(uninstallKey));
  installed = false;
  if (!fs.existsSync(path.join(temporary, 'profile/installed/Local/org.photoall.studio/library.sqlite'))) throw Error('Uninstaller deleted the user library');
  report.installer.uninstalled = true;
  report.installer.library_preserved = true;
  // NSIS retains its last-install-location preference after an ordinary uninstall.
  // This key did not exist before this test, so restore the original absence.
  await run(reg, ['delete', settingsKey, '/f'], {env}).catch(() => {});
  if (databaseHash(protectedDatabase) !== protectedDatabaseBefore) throw Error('Real AppData library changed during isolated QA');
  report.real_appdata_unchanged = true;
  report.real_appdata_sha256 = protectedDatabaseBefore;
  report.status = 'passed';
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, ...report}, null, 2));
})().catch(error => {
  fs.writeFileSync(path.join(output, 'error.txt'), String(error.stack || error));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (active?.pid) await run(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(active.pid), '/T', '/F'], {env}).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (installed && fs.existsSync(path.join(installedFolder, 'uninstall.exe'))) {
    const uninstaller = path.join(installedFolder, 'uninstall.exe');
    await run(uninstaller, ['/S', '_?=' + installedFolder], {env, windowsVerbatimArguments: true, argv0: '"' + uninstaller + '"'}).catch(() => {});
    await run(reg, ['delete', settingsKey, '/f'], {env}).catch(() => {});
  }
  const resolved = path.resolve(temporary);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('Photo All ')) {
    const cleanup = "import pathlib,shutil,sys,tempfile,time; target=pathlib.Path(sys.argv[1]).resolve(); assert target.parent==pathlib.Path(tempfile.gettempdir()).resolve() and target.name.startswith('Photo All ');\nfor attempt in range(10):\n try: shutil.rmtree(target); break\n except FileNotFoundError: break\n except PermissionError:\n  if attempt==9: raise\n  time.sleep(.3)";
    await run(path.join(portableSource, 'runtime/python/python.exe'), ['-c', cleanup, resolved], {env}).catch(error => {
      fs.writeFileSync(path.join(output, 'cleanup-error.txt'), String(error));
    });
  }
});
