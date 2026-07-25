"use strict";
/**
 * Cirqle Studio — main-thread (sandbox) code.
 *
 * This half owns the Figma document: scanning for card templates, duplicating
 * them, filling layers, placing images. It has no network access by design —
 * every byte arrives from ui.html, which talks to the Cirqle API.
 *
 * Hard rules enforced here:
 *  - Only the CURRENT page is ever modified. Nothing touches other pages.
 *  - Layer matching supports the existing Google-Sheets-plugin convention
 *    (#product, #offerprice, …) plus common human aliases — designers never
 *    rename a working template.
 *  - Every failure is reported as { what, where, fix }; nothing throws
 *    uncaught past the message router.
 */
figma.showUI(__html__, { width: 380, height: 720, themeColors: true });
/* ================================================================== *
 * Layer-name matching
 * ================================================================== */
/**
 * Alias → canonical token. The right side is the sheet-derived name
 * (`#` + column, lowercased, no spaces) that the API's `bindings.layers`
 * emits. The left side is what designers actually type on layers.
 *
 * The canonical names themselves always match (identity), so an existing
 * Sheets-plugin template needs zero renames — aliases only ADD tolerance.
 */
const TOKEN_ALIASES = {
    '#name': '#product',
    '#productname': '#product',
    '#title': '#offertitle',
    '#price': '#offerprice',
    '#sellingprice': '#offerprice',
    '#saleprice': '#offerprice',
    '#oldprice': '#mrp',
    '#strikeprice': '#mrp',
    '#originalprice': '#mrp',
    '#badge': '#badges',
    '#offer': '#offertext',
    '#image': '#imageurl',
    '#photo': '#imageurl',
    '#img': '#imageurl',
    '#productimage': '#imageurl',
    '#date': '#offerdatedisplay',
    '#size': '#weight',
    '#qty': '#weight',
};
function normalizeLayerName(raw) {
    return String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
}
/** Resolve a layer name to its canonical data token, or null if it isn't one. */
function layerToken(raw) {
    const name = normalizeLayerName(raw);
    if (!name.startsWith('#'))
        return null;
    return TOKEN_ALIASES[name] || name;
}
const IMAGE_TOKEN = '#imageurl';
/* ================================================================== *
 * Small helpers
 * ================================================================== */
function isText(node) {
    return node.type === 'TEXT';
}
function descendantsOf(root) {
    const self = [root];
    if ('findAll' in root && typeof root.findAll === 'function') {
        return self.concat(root.findAll(() => true));
    }
    return self;
}
/**
 * Every font in a text node must load before characters can change; a mixed-
 * font node needs each range font. Missing fonts are surfaced as a fix-it
 * message naming the font, not as a dead build.
 */
async function loadFontsFor(node) {
    const len = node.characters.length;
    if (len > 0) {
        for (const font of node.getRangeAllFontNames(0, len)) {
            await figma.loadFontAsync(font);
        }
        return;
    }
    if (node.fontName !== figma.mixed) {
        await figma.loadFontAsync(node.fontName);
        return;
    }
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
}
/** Neutral gray placeholder fill for products with no photo. */
const PLACEHOLDER_FILL = {
    type: 'SOLID',
    color: { r: 0.898, g: 0.906, b: 0.922 }, // #E5E7EB
};
function setImageFill(node, bytes) {
    const image = figma.createImage(bytes);
    let scaleMode = 'FILL'; // FILL = cover + centered crop
    if (node.fills && node.fills !== figma.mixed) {
        const existing = node.fills.find(f => f.type === 'IMAGE');
        if (existing && existing.scaleMode && existing.scaleMode !== 'CROP') {
            scaleMode = existing.scaleMode;
        }
    }
    ;
    node.fills = [{ type: 'IMAGE', scaleMode, imageHash: image.hash }];
}
function setPlaceholderFill(node) {
    ;
    node.fills = [PLACEHOLDER_FILL];
}
function fail(what, where, fix) {
    figma.ui.postMessage({ type: 'error', what, where, fix });
}
/**
 * A "template" is any component/frame on the CURRENT page whose descendants
 * include at least one #token layer. Components are preferred (instances stay
 * linked), but plain frames work — many real templates are frames.
 */
function scanTemplates() {
    const results = [];
    const roots = figma.currentPage.findAll(n => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'FRAME' || n.type === 'INSTANCE');
    for (const root of roots) {
        // A nested candidate inside another candidate is noise — only offer
        // top-level-ish nodes (parent is the page or a section-like container).
        const parentType = root.parent ? root.parent.type : 'PAGE';
        if (parentType !== 'PAGE' && parentType !== 'SECTION')
            continue;
        const tokens = new Set();
        for (const node of descendantsOf(root)) {
            const token = layerToken(node.name);
            if (token)
                tokens.add(token);
        }
        if (tokens.size > 0) {
            results.push({ id: root.id, name: root.name, nodeType: root.type, tokens: Array.from(tokens).sort() });
        }
    }
    return results;
}
/* ================================================================== *
 * Template validation (document side — data checks live in the UI)
 * ================================================================== */
async function validateTemplate(msg) {
    const issues = [];
    const template = (await figma.getNodeByIdAsync(msg.templateId));
    if (!template || template.removed) {
        figma.ui.postMessage({
            type: 'template-validated',
            issues: [{
                    severity: 'error', area: 'template',
                    message: 'The selected template no longer exists on this page.',
                    fix: 'Press Refresh to re-scan templates, then pick one again.',
                }],
            tokens: [],
        });
        return;
    }
    const tokens = new Set();
    let textTokens = 0;
    for (const node of descendantsOf(template)) {
        const token = layerToken(node.name);
        if (!token)
            continue;
        tokens.add(token);
        if (isText(node))
            textTokens++;
        if (token === IMAGE_TOKEN && isText(node)) {
            issues.push({
                severity: 'warning', area: 'template',
                message: `"${node.name}" is a TEXT layer but should be a shape/frame — images become fills, not characters.`,
                fix: 'Rename the text layer, and name the picture rectangle #imageurl instead.',
            });
        }
    }
    if (!tokens.has('#product')) {
        issues.push({
            severity: 'error', area: 'template',
            message: 'No #product layer found — cards would build with no product name.',
            fix: 'Name the product-name text layer "#product" (aliases: #name, #productname).',
        });
    }
    if (!tokens.has('#offerprice')) {
        issues.push({
            severity: 'warning', area: 'template',
            message: 'No #offerprice layer found — prices will not appear.',
            fix: 'Name the price text layer "#offerprice" (alias: #price). Skip if this template is price-free on purpose.',
        });
    }
    if (!tokens.has(IMAGE_TOKEN)) {
        issues.push({
            severity: 'warning', area: 'template',
            message: 'No #imageurl layer found — product photos will not be placed.',
            fix: 'Name the photo rectangle/frame "#imageurl" (aliases: #image, #photo).',
        });
    }
    if (textTokens === 0) {
        issues.push({
            severity: 'error', area: 'template',
            message: 'The template has #-layers but none of them are text layers.',
            fix: 'Data fills TEXT layers; check the layer types in the template.',
        });
    }
    figma.ui.postMessage({ type: 'template-validated', issues, tokens: Array.from(tokens).sort() });
}
async function makeCard(template) {
    if (template.type === 'COMPONENT')
        return template.createInstance();
    if (template.type === 'COMPONENT_SET')
        return template.defaultVariant.createInstance();
    return template.clone();
}
async function fillCard(card, product) {
    let filled = 0;
    const matched = new Set();
    let imageState = 'none';
    for (const node of descendantsOf(card)) {
        const token = layerToken(node.name);
        if (!token)
            continue;
        if (token === IMAGE_TOKEN) {
            if (isText(node))
                continue; // warned during validation; never fatal here
            if (product.image) {
                setImageFill(node, product.image);
                imageState = 'placed';
                filled++;
            }
            else {
                setPlaceholderFill(node);
                if (imageState !== 'placed')
                    imageState = 'placeholder';
            }
            matched.add(token);
            continue;
        }
        if (!isText(node))
            continue;
        const value = product.fields[token];
        matched.add(token);
        if (value === undefined)
            continue;
        if (value === '') {
            // Hide, don't print blanks: an empty MRP layer would leave a floating
            // strikethrough on the printed flyer.
            node.visible = false;
            continue;
        }
        node.visible = true;
        await loadFontsFor(node);
        node.characters = value;
        filled++;
    }
    const missing = Object.keys(product.fields)
        .filter(t => product.fields[t] !== '' && !matched.has(t));
    return { filled, missing, imageState };
}
async function buildFlyer(msg) {
    const template = (await figma.getNodeByIdAsync(msg.templateId));
    if (!template || template.removed) {
        fail('Build could not start.', 'Template lookup', 'The chosen template was deleted or moved to another page. Press Refresh and pick a template again.');
        return;
    }
    if (msg.products.length === 0) {
        fail('Nothing to build.', 'Product list', 'The selected offer/page has no products. Pick another page or offer.');
        return;
    }
    const width = template.width || 200;
    const height = template.height || 200;
    const cols = Math.max(1, msg.columns || 4);
    const gap = Number.isFinite(msg.gap) ? msg.gap : 40;
    const rows = Math.ceil(msg.products.length / cols);
    // Everything lands inside ONE new frame on the CURRENT page — the plugin
    // never edits existing nodes and never touches other pages.
    const wrapper = figma.createFrame();
    wrapper.name = msg.frameName || 'Cirqle Studio build';
    wrapper.fills = [];
    wrapper.clipsContent = false;
    wrapper.x = (template.x || 0);
    wrapper.y = (template.y || 0) + height + gap * 2;
    wrapper.resize(Math.max(1, cols * width + (cols - 1) * gap), Math.max(1, rows * height + (rows - 1) * gap));
    figma.currentPage.appendChild(wrapper);
    const report = {
        cards: 0,
        layersFilled: 0,
        imagesPlaced: 0,
        placeholders: 0,
        missingLayerCounts: {},
    };
    for (let i = 0; i < msg.products.length; i++) {
        let card;
        try {
            card = await makeCard(template);
        }
        catch (err) {
            fail('Could not duplicate the template for product ' + (i + 1) + '.', 'Card creation', (err instanceof Error ? err.message : String(err)) + ' — check the template is not locked.');
            continue;
        }
        card.name = msg.products[i].fields['#product'] || `Product ${i + 1}`;
        wrapper.appendChild(card);
        card.x = (i % cols) * (width + gap);
        card.y = Math.floor(i / cols) * (height + gap);
        try {
            const res = await fillCard(card, msg.products[i]);
            report.cards++;
            report.layersFilled += res.filled;
            if (res.imageState === 'placed')
                report.imagesPlaced++;
            if (res.imageState === 'placeholder')
                report.placeholders++;
            for (const token of res.missing) {
                report.missingLayerCounts[token] = (report.missingLayerCounts[token] || 0) + 1;
            }
        }
        catch (err) {
            // Most common real cause: a font Figma can't load.
            fail('Card ' + (i + 1) + ' (' + card.name + ') could not be filled completely.', 'Layer fill', (err instanceof Error ? err.message : String(err)) +
                ' — if this mentions a font, install/enable that font and rebuild.');
        }
        figma.ui.postMessage({ type: 'progress', done: i + 1, total: msg.products.length });
    }
    figma.currentPage.selection = [wrapper];
    figma.viewport.scrollAndZoomIntoView([wrapper]);
    figma.ui.postMessage({ type: 'build-done', report });
    figma.notify(`Cirqle Studio: built ${report.cards} card${report.cards === 1 ? '' : 's'}.`);
}
/* ================================================================== *
 * Message router — the single uncaught-error boundary.
 * ================================================================== */
const SETTINGS_KEY = 'cirqle-studio-settings';
figma.ui.onmessage = async (msg) => {
    try {
        switch (msg.type) {
            case 'ready': {
                const saved = await figma.clientStorage.getAsync(SETTINGS_KEY);
                figma.ui.postMessage({ type: 'init', settings: saved || null });
                figma.ui.postMessage({ type: 'templates', templates: scanTemplates() });
                break;
            }
            case 'save-settings':
                await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
                break;
            case 'scan-templates':
                figma.ui.postMessage({ type: 'templates', templates: scanTemplates() });
                break;
            case 'validate-template':
                await validateTemplate(msg);
                break;
            case 'build':
                await buildFlyer(msg);
                break;
            case 'notify':
                figma.notify(String(msg.message || ''));
                break;
            case 'close':
                figma.closePlugin();
                break;
            default:
                break;
        }
    }
    catch (err) {
        fail('Unexpected plugin error.', 'Action: ' + String(msg && msg.type), (err instanceof Error ? err.message : String(err)) + ' — press Refresh; if it repeats, reopen the plugin.');
    }
};
