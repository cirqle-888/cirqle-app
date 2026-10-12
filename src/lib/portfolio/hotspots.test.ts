import {describe,it,expect} from 'vitest'
import {coverBox,readHotspots,validHotspots,validGalleryPath,hotspotColour,HOTSPOT_COLOURS,DEFAULT_HOTSPOT_COLOUR} from './hotspots'
const area={id:'one',label:'Roots social media',path:'/portfolio/social-media/roots',points:[[30,30],[70,30],[70,70],[30,70]]}
describe('presentation hotspots',()=>{
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
  // A free hex is refused at the door, because the value reaches CSS.
  for(const bad of ['#fff','red','brand;--x:y','toString','__proto__',1])expect(validHotspots({desktop:[{...area,color:bad}],mobile:[]})).toBe(false)
 })
 it('resolves any stored colour to a known hex, falling back to the brand',()=>{
  expect(hotspotColour('cyan')).toBe(HOTSPOT_COLOURS.cyan)
  // Cirqle brand violet — the site's theme-color and the colour of its focus rings.
  expect(HOTSPOT_COLOURS[DEFAULT_HOTSPOT_COLOUR]).toBe('#7c5cff')
  for(const junk of [undefined,null,'','nope','constructor','#ff0000',{}])expect(hotspotColour(junk)).toBe('#7c5cff')
 })
 it('tracks cover crops and focal positions exactly',()=>{
  expect(coverBox(400,800,1600,900,50,50)).toEqual({width:1600*800/900,height:800,left:(400-1600*800/900)/2,top:0})
  const right=coverBox(400,800,1600,900,100,0);expect(right.left+right.width).toBe(400)
  const tall=coverBox(1200,600,900,1600,50,100);expect(tall.top+tall.height).toBe(600)
 })
})
