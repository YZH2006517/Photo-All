// Standalone release QA: relocate portable files, install per-user, launch, uninstall.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.env.PHOTOALL_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const [portableSource, installer] = process.argv.slice(2).map(p => path.resolve(p));
if (!portableSource || !installer) throw Error('Pass portable directory and NSIS installer');
const output = path.join(__dirname, 'artifacts', 'package-native-' + Date.now());
fs.mkdirSync(output, {recursive: true});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'Photo All 独立发布 '));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PHOTOALL|PYTHON)/.test(key)));
env.PATH = path.join(process.env.SystemRoot, 'System32');
env.APPDATA = path.join(temporary, 'profile', 'Roaming');
env.LOCALAPPDATA = path.join(temporary, 'profile', 'Local');
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Photo All Studio';
const settingsKey = 'HKCU\\Software\\photoall\\Photo All Studio';
const run = (file, args, options = {}) => new Promise((resolve, reject) => {
  const process = spawn(file, args, {windowsHide: true, ...options});
  let stdout = '', stderr = '';
  process.stdout?.on('data', chunk => stdout += chunk);
  process.stderr?.on('data', chunk => stderr += chunk);
  process.once('error', reject);
  process.once('exit', code => code === 0 ? resolve({code, stdout, stderr}) : reject(Error(`${file} returned ${code}: ${stderr}`)));
});
const existsKey = key => spawnSync('reg.exe', ['query', key], {windowsHide: true, env, encoding: 'utf8'}).status === 0;
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
async function exercise(executable, phase, port) {
  const data = path.join(temporary, 'profile', phase, 'Local', 'org.photoall.studio');
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
  if ((await api('/library')).photos.length !== 0) throw Error('Isolated AppData profile is not empty');
  const fixture = path.join(temporary, phase + '.png');
  await run(path.join(path.dirname(executable), 'runtime/python/python.exe'), ['-c',
    "from PIL import Image; import sys; Image.new('RGB',(360,240),(73,129,173)).save(sys.argv[1])", fixture], {env: appEnv});
  const job = await api('/import', {paths: [fixture]});
  await waitFor(async () => (await api('/jobs/' + job.id)).status === 'done');
  if ((await api('/library')).photos.length !== 1) throw Error('Imported photo missing');
  await page.reload();
  await page.getByRole('heading', {name: '图集', exact: true}).waitFor();
  await page.screenshot({path: path.join(output, phase + '.png')});
  const backend = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${active.pid}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
    {env, windowsHide: true, encoding: 'utf8'}).stdout.trim();
  if (!backend.includes('runtime') || /codex-runtimes|PHOTO ALL\\product/.test(backend)) throw Error('Native process used the builder runtime: ' + backend);
  fs.writeFileSync(path.join(output, phase + '-processes.json'), backend);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label: 'main'})).catch(() => {});
  await waitFor(() => closed);
  let reachable = true;
  try { await api('/library'); } catch { reachable = false; }
  if (reachable) throw Error('Backend survived native close');
  if (!fs.existsSync(path.join(data, 'library.sqlite'))) throw Error('AppData library missing');
  await browser.close().catch(() => {});
  browser = undefined;
  active = undefined;
  return {native_started: true, authenticated_api: true, import: true, isolated_appdata: true,
    bundled_interpreter: true, no_workspace_path: true, native_close: true, backend_cleanup: true};
}
(async () => {
  if (existsKey(uninstallKey) || existsKey(settingsKey)) throw Error('An existing user installation/profile registry entry must be preserved; test installation aborted');
  const portable = path.join(temporary, '便携 application');
  fs.cpSync(portableSource, portable, {recursive: true});
  report.portable = await exercise(path.join(portable, 'Photo All Studio.exe'), 'portable', 9438);
  const install = await run(installer, ['/S', '/NS', '/D=' + installedFolder], {env});
  fs.writeFileSync(path.join(output, 'install-process.json'), JSON.stringify(install, null, 2));
  installed = true;
  if (!existsKey(uninstallKey) || !fs.existsSync(path.join(installedFolder, 'photo-all.exe'))) throw Error('Per-user installer did not register/install the application');
  report.installer = {per_user_registry: true, no_shortcuts: true,
    ...await exercise(path.join(installedFolder, 'photo-all.exe'), 'installed', 9439)};
  const uninstall = await run(path.join(installedFolder, 'uninstall.exe'), ['/S', '_?=' + installedFolder], {env});
  fs.writeFileSync(path.join(output, 'uninstall-process.json'), JSON.stringify(uninstall, null, 2));
  await waitFor(() => !fs.existsSync(path.join(installedFolder, 'photo-all.exe')) && !existsKey(uninstallKey));
  installed = false;
  if (!fs.existsSync(path.join(temporary, 'profile/installed/Local/org.photoall.studio/library.sqlite'))) throw Error('Uninstaller deleted the user library');
  report.installer.uninstalled = true;
  report.installer.library_preserved = true;
  report.status = 'passed';
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, ...report}, null, 2));
})().catch(error => {
  fs.writeFileSync(path.join(output, 'error.txt'), String(error.stack || error));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  active?.kill();
  if (installed && fs.existsSync(path.join(installedFolder, 'uninstall.exe'))) {
    await run(path.join(installedFolder, 'uninstall.exe'), ['/S', '_?=' + installedFolder], {env}).catch(() => {});
  }
  const resolved = path.resolve(temporary);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('Photo All ')) {
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 300});
  }
});
