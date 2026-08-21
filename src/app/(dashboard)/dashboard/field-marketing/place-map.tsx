'use client'

/**
 * Leaflet map canvas for Field Marketing. Imperative (no react-leaflet — avoids
 * React-19 peer friction) and loaded via dynamic(..., { ssr: false }) from the
 * client, so `leaflet` never touches the server bundle.
 *
 * Pins are L.divIcon SVGs tinted per status — this sidesteps Leaflet's classic
 * broken-default-marker-image problem AND gives us the colour coding for free.
 * OpenStreetMap tiles need no API key; the only app CSP rule is
 * frame-ancestors, so tiles/geocoding are not blocked.
 */

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { STATUS_COLOR, type FieldPlace } from '@/lib/field/types'

export interface UserLocation {
  latitude: number
  longitude: number
  accuracy?: number
}

interface PlaceMapProps {
  places: FieldPlace[]
  selectedId: string | null
  userLocation: UserLocation | null
  addMode: boolean
  draftPin: { latitude: number; longitude: number } | null
  onSelect: (id: string) => void
  onMapClick: (lat: number, lng: number) => void
  /** Bump this to re-fit the map to all pins (e.g. after a filter change). */
  fitSignal?: number
  /** Change `nonce` to imperatively fly the map to a point (e.g. "Locate me"). */
  flyTo?: { latitude: number; longitude: number; zoom?: number; nonce: number } | null
  className?: string
}

const INDIA_CENTER: [number, number] = [20.5937, 78.9629]

function pinIcon(color: string, selected: boolean): L.DivIcon {
  const scale = selected ? 1.35 : 1
  const ring = selected ? '<circle cx="12" cy="9" r="11" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.9"/>' : ''
  const html = `
    <div style="transform:translate(-50%,-100%) scale(${scale});transform-origin:bottom center;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">
      <svg width="24" height="30" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg">
        ${ring}
        <path d="M12 0C6.5 0 2 4.5 2 10c0 6.5 10 20 10 20s10-13.5 10-20C22 4.5 17.5 0 12 0z" fill="${color}"/>
        <circle cx="12" cy="10" r="4" fill="#fff"/>
      </svg>
    </div>`
  return L.divIcon({ html, className: 'field-pin', iconSize: [24, 30], iconAnchor: [0, 0] })
}

function userIcon(): L.DivIcon {
  const html = `
    <div style="transform:translate(-50%,-50%)">
      <div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.5)"></div>
    </div>`
  return L.divIcon({ html, className: 'field-user-dot', iconSize: [16, 16], iconAnchor: [0, 0] })
}

export default function PlaceMap({
  places, selectedId, userLocation, addMode, draftPin,
  onSelect, onMapClick, fitSignal, flyTo, className,
}: PlaceMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const clusterRef = useRef<L.LayerGroup | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const userMarkerRef = useRef<L.Marker | null>(null)
  const accuracyRef = useRef<L.Circle | null>(null)
  const draftMarkerRef = useRef<L.Marker | null>(null)
  // Latest callbacks read through refs so the mount effect can run exactly once.
  // Synced in an effect (not during render) per the react-hooks/refs rule.
  const onSelectRef = useRef(onSelect)
  const onMapClickRef = useRef(onMapClick)
  const addModeRef = useRef(addMode)
  useEffect(() => {
    onSelectRef.current = onSelect
    onMapClickRef.current = onMapClick
    addModeRef.current = addMode
  })

  // ── Mount: create the map once ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true })
      .setView(INDIA_CENTER, 5)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cluster = (L as any).markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false })
    cluster.addTo(map)
    clusterRef.current = cluster

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (addModeRef.current) onMapClickRef.current(e.latlng.lat, e.latlng.lng)
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ── Cursor hint while in add mode ───────────────────────────────────────────
  useEffect(() => {
    const el = mapRef.current?.getContainer()
    if (el) el.style.cursor = addMode ? 'crosshair' : ''
  }, [addMode])

  // ── Rebuild pins when places / selection change ─────────────────────────────
  useEffect(() => {
    const cluster = clusterRef.current
    if (!cluster) return
    cluster.clearLayers()
    markersRef.current.clear()
    for (const p of places) {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue
      const m = L.marker([p.latitude, p.longitude], {
        icon: pinIcon(STATUS_COLOR[p.status] ?? '#64748b', p.id === selectedId),
        zIndexOffset: p.id === selectedId ? 1000 : 0,
      })
      m.bindTooltip(p.name, { direction: 'top', offset: [0, -26] })
      m.on('click', () => onSelectRef.current(p.id))
      cluster.addLayer(m)
      markersRef.current.set(p.id, m)
    }
  }, [places, selectedId])

  // ── Pan to the selected place ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId) return
    const p = places.find((x) => x.id === selectedId)
    if (p && Number.isFinite(p.latitude)) {
      map.setView([p.latitude, p.longitude], Math.max(map.getZoom(), 15), { animate: true })
    }
  }, [selectedId, places])

  // ── Fit to all pins on demand (filter/initial) ──────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const pts = places.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    if (pts.length === 0) {
      if (userLocation) map.setView([userLocation.latitude, userLocation.longitude], 14)
      return
    }
    if (pts.length === 1) { map.setView([pts[0].latitude, pts[0].longitude], 15); return }
    const bounds = L.latLngBounds(pts.map((p) => [p.latitude, p.longitude] as [number, number]))
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal])

  // ── Imperative fly-to (Locate me / external focus) ──────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !flyTo) return
    map.setView([flyTo.latitude, flyTo.longitude], flyTo.zoom ?? 15, { animate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce])

  // ── "You are here" marker + accuracy circle ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!userLocation) {
      userMarkerRef.current?.remove(); userMarkerRef.current = null
      accuracyRef.current?.remove(); accuracyRef.current = null
      return
    }
    const ll: [number, number] = [userLocation.latitude, userLocation.longitude]
    if (userMarkerRef.current) userMarkerRef.current.setLatLng(ll)
    else userMarkerRef.current = L.marker(ll, { icon: userIcon(), interactive: false, zIndexOffset: 500 }).addTo(map)

    if (userLocation.accuracy && userLocation.accuracy > 0) {
      if (accuracyRef.current) accuracyRef.current.setLatLng(ll).setRadius(userLocation.accuracy)
      else accuracyRef.current = L.circle(ll, {
        radius: userLocation.accuracy, color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.08,
      }).addTo(map)
    }
  }, [userLocation])

  // ── Draft pin (place being added) ───────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!draftPin) { draftMarkerRef.current?.remove(); draftMarkerRef.current = null; return }
    const ll: [number, number] = [draftPin.latitude, draftPin.longitude]
    if (draftMarkerRef.current) draftMarkerRef.current.setLatLng(ll)
    else {
      draftMarkerRef.current = L.marker(ll, { icon: pinIcon('#111827', true), zIndexOffset: 1500 }).addTo(map)
    }
    map.setView(ll, Math.max(map.getZoom(), 16), { animate: true })
  }, [draftPin])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} aria-label="Territory map" />
}
