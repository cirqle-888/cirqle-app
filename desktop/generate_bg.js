const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body {
        margin: 0;
        width: 800px;
        height: 500px;
        background: radial-gradient(circle at center, #1a1b26 0%, #0d0f16 100%);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #fff;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      
      .brand {
        position: absolute;
        top: 60px;
        text-align: center;
      }
      
      .brand h1 {
        font-size: 36px;
        font-weight: 700;
        margin: 0;
        letter-spacing: -0.5px;
        background: linear-gradient(135deg, #fff 0%, #a1a1aa 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      
      .brand p {
        font-size: 16px;
        color: #71717a;
        margin-top: 8px;
      }

      .instruction {
        position: absolute;
        top: 180px;
        font-size: 20px;
        font-weight: 500;
        color: #d4d4d8;
        background: rgba(255, 255, 255, 0.05);
        padding: 12px 24px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
      }

      .arrow-container {
        position: absolute;
        top: 340px;
        left: 400px;
        transform: translate(-50%, -50%);
        width: 160px;
        height: 2px;
        background: repeating-linear-gradient(90deg, rgba(255,255,255,0.2) 0, rgba(255,255,255,0.2) 6px, transparent 6px, transparent 12px);
      }
      
      .arrow-head {
        position: absolute;
        right: -4px;
        top: -6px;
        width: 0; 
        height: 0; 
        border-top: 7px solid transparent;
        border-bottom: 7px solid transparent;
        border-left: 10px solid rgba(255,255,255,0.5);
      }
      
      /* Glowing orbs for background effect */
      .orb-1 {
        position: absolute;
        top: -100px;
        left: -100px;
        width: 400px;
        height: 400px;
        background: radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, transparent 70%);
        border-radius: 50%;
        filter: blur(40px);
      }
      
      .orb-2 {
        position: absolute;
        bottom: -150px;
        right: -100px;
        width: 500px;
        height: 500px;
        background: radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, transparent 70%);
        border-radius: 50%;
        filter: blur(40px);
      }
    </style>
  </head>
  <body>
    <div class="orb-1"></div>
    <div class="orb-2"></div>
    
    <div class="brand">
      <h1>Cirqle Desktop</h1>
      <p>Business Management Workspace</p>
    </div>
    
    <div class="instruction">
      Drag the icon to the Applications folder to install
    </div>
    
    <div class="arrow-container">
      <div class="arrow-head"></div>
    </div>
  </body>
  </html>
  `;

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.screenshot({ path: 'assets/dmg-background.png' });
  await browser.close();
})();
