const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert')
const {spawn} = require('child_process')
const root = process.cwd(), puppeteer = require(root+'/node_modules/puppeteer')
const wait = ms => new Promise(r => setTimeout(r,ms))
;(async()=>{
 const temp = fs.mkdtempSync(path.join(os.tmpdir(),'cirqle-runtime-'))
 const server = http.createServer((req,res) => {res.setHeader('Content-Type','text/html');res.end('<main data-client-scope="'+new URL(req.url,'http://localhost').searchParams.get('cirqleClient')+'"><h1>Test pane</h1><span role="status" data-desktop-save-state="saved" data-desktop-dirty="false">Saved to Offer Studio</span></main>')})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const port = server.address().port, debugPort = port+1
 fs.mkdirSync(temp+'/userdata')
 fs.writeFileSync(temp+'/userdata/layout.json',JSON.stringify({panes:['cirqle','studio'],sizes:[.4,.6],showToolbar:true,waAccounts:[{id:'default',label:'Test account'}],activeWa:'default',webTabs:[]}))
 fs.writeFileSync(temp+'/package.json',JSON.stringify({name:'cirqle-runtime-check',version:'0.10.0',main:'bootstrap.cjs'}))
 fs.writeFileSync(temp+'/bootstrap.cjs',`
 const electron=require('electron');
 electron.systemPreferences.getMediaAccessStatus=()=> 'granted';
 electron.dialog.showMessageBox=async()=>({response:0});
 electron.dialog.showMessageBoxSync=()=>0;
 electron.app.whenReady().then(()=>setTimeout(()=>electron.BaseWindow.getAllWindows().forEach(w=>w.hide()),100));
 require(${JSON.stringify(root+'/src/main/updates.js')}).startPeriodicChecks=()=>{};
 require(${JSON.stringify(root+'/src/main.js')});`)
 let stderr='', browser, child
 try {
 child=spawn(root+'/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',[temp,'--remote-debugging-port='+debugPort],{env:{...process.env,CIRQLE_USERDATA:temp+'/userdata',CIRQLE_URL:'http://127.0.0.1:'+port,STUDIO_URL:'http://127.0.0.1:'+port+'/flyer'},stdio:['ignore','ignore','pipe']})
 child.stderr.on('data',d=>stderr+=d)
 for(let i=0;i<60;i++){if(child.exitCode!==null)throw new Error('Electron exited: '+stderr);try{const r=await fetch('http://127.0.0.1:'+debugPort+'/json/version');if(r.ok)break}catch{}await wait(150)}
 browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+debugPort,defaultViewport:null})
 let toolbar
 for(let i=0;i<40;i++){toolbar=(await browser.pages()).find(p=>p.url().endsWith('/host.html'));if(toolbar)break;await wait(100)}
 assert.ok(toolbar,'toolbar available')
 await toolbar.waitForSelector('[data-pane="studio"]')
 const result=await toolbar.evaluate(()=>window.desk.saveWorkspace('Smoke layout'))
 assert.strictEqual(result.ok,true,'IPC accepts the trusted toolbar')
 await toolbar.$eval('[aria-label="Expand Flyer Cirqle"]',b=>b.click())
 await toolbar.waitForSelector('[aria-label="Restore layout"]')
 const pages=await browser.pages(), flyer=pages.find(p=>p.url().endsWith('/flyer'))
 assert.ok(flyer)
 await flyer.waitForFunction(()=>innerWidth>=1400)
 const width=await flyer.evaluate(()=>innerWidth)
 assert.ok(width>=1400,'expanded pane gets full window width')
 await toolbar.$eval('[aria-label="Restore layout"]',b=>b.click())
 await toolbar.waitForSelector('[aria-label="Expand Flyer Cirqle"]')
 await flyer.evaluate(()=>{const el=document.querySelector('[role="status"]');el.dataset.desktopSaveState='saving';el.dataset.desktopDirty='true';el.textContent='Saving…'})
 await wait(100);
 await toolbar.waitForFunction(()=>document.querySelector('[data-pane="studio"] .pane-state')?.textContent==='Saving…',{timeout:10000,polling:100})
 await toolbar.$eval('[aria-label="Close Flyer Cirqle"]',b=>b.click());await wait(300)
 assert.ok(await toolbar.$('[data-pane="studio"]'),'dirty close is cancelled')
 await flyer.evaluate(()=>{const el=document.querySelector('[role="status"]');el.dataset.desktopSaveState='saved';el.dataset.desktopDirty='false';el.textContent='Saved'})
 await toolbar.waitForFunction(()=>document.querySelector('[data-pane="studio"] .pane-state')?.textContent==='Saved',{timeout:10000,polling:100})
 await toolbar.$eval('[aria-label="Close Flyer Cirqle"]',b=>b.click())
 await toolbar.waitForFunction(()=>!document.querySelector('[data-pane="studio"]'),{timeout:10000,polling:100})
 assert.strictEqual((await toolbar.$$('[data-pane]')).length,1)
 assert.ok(JSON.parse(fs.readFileSync(temp+'/userdata/layout.json')).savedWorkspaces.some(w=>w.name==='Smoke layout'))
 const clientPage=(await browser.pages()).find(p=>p.url()==='http://127.0.0.1:'+port+'/')
 assert.ok(clientPage)
 const clientId='12345678-1234-4234-8234-123456789012'
 await clientPage.evaluate(id=>{void window.__CIRQLE_DESKTOP__.openClientWorkspace({id,name:'Test client',code:'TEST'})},clientId)
 await wait(500)
 const clientPages=await browser.pages()
 assert.ok(clientPages.some(p=>p.url().includes('/dashboard/tasks?client='+clientId)))
 assert.ok(clientPages.some(p=>p.url().includes('/dashboard/invoices?client='+clientId)))
 const scopedFlyer=clientPages.find(p=>p.url().includes('cirqleClient='+clientId))
 assert.ok(scopedFlyer)
 assert.strictEqual(await scopedFlyer.$('#desktop-flyer-scope-message'),null)
 await toolbar.screenshot({path:'/tmp/cirqle-client-workspace.png'})
 console.log('Actual Electron smoke test: startup, trusted IPC, saved layout persistence, expand/restore, live save feedback and dirty-close guard passed')
 }finally{if(browser)await browser.disconnect();if(child)child.kill('SIGKILL');server.close();await wait(200);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
