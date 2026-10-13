import {describe,it,expect} from 'vitest'
import {coverBox,readHotspots,validHotspots,validGalleryPath,hotspotColour,hotspotGlow,hasGradient,normaliseGlowColour,HOTSPOT_COLOURS,DEFAULT_HOTSPOT_COLOUR} from './hotspots'
const area={id:'one',label:'Roots social media',path:'/portfolio/social-media/roots',points:[[30,30],[70,30],[70,70],[30,70]]}
describe('presentation hotspots',()=>{
 it('keeps legacy glow settings and validates per-area strength',()=>{
  for(const glowStrength of [undefined,null,.25,1,3])expect(validHotspots({desktop:[{...area,glowStrength}],mobile:[]})).toBe(true)
  for(const glowStrength of [0,-1,3.1,NaN,Infinity,'2'])expect(validHotspots({desktop:[{...area,glowStrength}],mobile:[]})).toBe(false)
 })
 it('accepts detailed mask contours but keeps the payload bounded',()=>{
  const ring=(count:number)=>Array.from({length:count},(_,i)=>[50+20*Math.cos(i/count*2*Math.PI),50+20*Math.sin(i/count*2*Math.PI)])
  expect(validHotspots({desktop:[{...area,points:ring(180)}],mobile:[]})).toBe(true)
  expect(validHotspots({desktop:[{...area,points:ring(257)}],mobile:[]})).toBe(false)
 })
 it('keeps independent mobile geometry and accepts original image coordinates',()=>{expect(validHotspots({desktop:[area],mobile:[]})).toBe(true)})
 it('rejects unsafe destinations, malformed points, excessive count and degenerate shapes',()=>{
  for(const path of ['https://evil.test','//evil.test','/portfolio/../admin','/portfolio/%2fadmin','/portfolio/a?redirect=https://evil.test'])expect(validGalleryPath(path)).toBe(false)
  for(const change of [{points:[[1,1],[1,1],[1,1]]},{points:[[0,0],[101,0],[20,40]]},{label:''},{points:[[0,0],[NaN,2],[30,40]]}])expect(validHotspots({desktop:[{...area,...change}],mobile:[]})).toBe(false)
  expect(validHotspots({desktop:Array(9).fill(area),mobile:[]})).toBe(false)
  expect(readHotspots(null)).toEqual({desktop:[],mobile:[]})
 })
 it('accepts a known glow colour and rejects anything else',()=>{
  expect(validHotspots({desktop:[{...area,color:'cyan'}],mobile:[]})).toBe(true)
  // Absent is valid: every area saved before colours existed must stay loadable.
  expect(validHotspots({desktop:[{...area,color:null}],mobile:[]})).toBe(true)
  expect(validHotspots({desktop:[area],mobile:[]})).toBe(true)
  // A custom hex is allowed, so the hex rule is what keeps CSS safe.
  expect(validHotspots({desktop:[{...area,color:'#FF8800'}],mobile:[]})).toBe(true)
  for(const bad of ['#fff','#12345g','red','rgb(1,2,3)','brand;--x:y','#7c5cff;background:url(x)','toString','__proto__',1])expect(validHotspots({desktop:[{...area,color:bad}],mobile:[]})).toBe(false)
 })
 it('accepts a gradient end and rejects a bad one',()=>{
  expect(validHotspots({desktop:[{...area,color:'brand',colorTo:'cyan'}],mobile:[]})).toBe(true)
  expect(validHotspots({desktop:[{...area,color:'#7c5cff',colorTo:'#4cc3ff'}],mobile:[]})).toBe(true)
  expect(validHotspots({desktop:[{...area,colorTo:'javascript:alert(1)'}],mobile:[]})).toBe(false)
 })
 it('reads the two ends of the glow, and says when it is really a gradient',()=>{
  expect(hotspotGlow({})).toEqual({from:'#7c5cff',to:'#7c5cff'})
  expect(hasGradient({})).toBe(false)
  expect(hotspotGlow({color:'brand',colorTo:'cyan'})).toEqual({from:'#7c5cff',to:'#4cc3ff'})
  expect(hasGradient({color:'brand',colorTo:'cyan'})).toBe(true)
  // Same colour at both ends is a flat glow, not a gradient.
  expect(hasGradient({color:'#7C5CFF',colorTo:'#7c5cff'})).toBe(false)
  // An unusable end falls back to a flat glow rather than to the brand.
  expect(hotspotGlow({color:'cyan',colorTo:'nope'})).toEqual({from:'#4cc3ff',to:'#4cc3ff'})
 })
 it('normalises a hex and refuses anything that is not one',()=>{
  expect(normaliseGlowColour('#AABBCC')).toBe('#aabbcc')
  expect(normaliseGlowColour('cyan')).toBe('#4cc3ff')
  for(const bad of ['#abc','#aabbccdd','white ','',null,undefined,{}])expect(normaliseGlowColour(bad)).toBeNull()
 })
 it('resolves any stored colour to a known hex, falling back to the brand',()=>{
  expect(hotspotColour('cyan')).toBe(HOTSPOT_COLOURS.cyan)
  // Cirqle brand violet — the site's theme-color and the colour of its focus rings.
  expect(HOTSPOT_COLOURS[DEFAULT_HOTSPOT_COLOUR]).toBe('#7c5cff')
  // '#ff0000' is now a real colour, so it is no longer in the junk list.
  for(const junk of [undefined,null,'','nope','constructor','#f00',{}])expect(hotspotColour(junk)).toBe('#7c5cff')
  expect(hotspotColour('#ff0000')).toBe('#ff0000')
 })
 it('tracks cover crops and focal positions exactly',()=>{
  expect(coverBox(400,800,1600,900,50,50)).toEqual({width:1600*800/900,height:800,left:(400-1600*800/900)/2,top:0})
  const right=coverBox(400,800,1600,900,100,0);expect(right.left+right.width).toBe(400)
  const tall=coverBox(1200,600,900,1600,50,100);expect(tall.top+tall.height).toBe(600)
 })
})
