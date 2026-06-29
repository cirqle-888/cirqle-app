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
        background: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #111827;
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
        color: #111827;
      }
      
      .brand p {
        font-size: 16px;
        color: #6b7280;
        margin-top: 8px;
      }

      .instruction {
        position: absolute;
        top: 180px;
        font-size: 20px;
        font-weight: 500;
        color: #374151;
        background: rgba(243, 244, 246, 0.5);
        padding: 12px 24px;
        border-radius: 20px;
        border: 1px solid rgba(229, 231, 235, 1);
      }

      .arrow-container {
        position: absolute;
        top: 340px;
        left: 400px;
        transform: translate(-50%, -50%);
        width: 160px;
        height: 2px;
        background: repeating-linear-gradient(90deg, #9ca3af 0, #9ca3af 6px, transparent 6px, transparent 12px);
      }
      
      .arrow-head {
        position: absolute;
        right: -4px;
        top: -6px;
        width: 0; 
        height: 0; 
        border-top: 7px solid transparent;
        border-bottom: 7px solid transparent;
        border-left: 10px solid #9ca3af;
      }
      
      /* Subtle glowing orbs for background effect */
      .orb-1 {
        position: absolute;
        top: -100px;
        left: -100px;
        width: 400px;
        height: 400px;
        background: radial-gradient(circle, rgba(139, 92, 246, 0.08) 0%, transparent 70%);
        border-radius: 50%;
        filter: blur(40px);
      }
      
      .orb-2 {
        position: absolute;
        bottom: -150px;
        right: -100px;
        width: 500px;
        height: 500px;
        background: radial-gradient(circle, rgba(59, 130, 246, 0.05) 0%, transparent 70%);
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
  await page.screenshot({ path: 'assets/dmg-background-white@2x.png' });
  
  await page.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
  await page.screenshot({ path: 'assets/dmg-background-white.png' });
  
  await browser.close();
})();
