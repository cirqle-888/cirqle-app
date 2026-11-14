/* Cirqle push service worker. Registered by the PushToggle component.
   Shows a notification on 'push' and focuses/open the app on click. */

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (_e) { data = {} }
  const title = data.title || 'Cirqle'
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    // A second alert with the same tag still buzzes instead of silently replacing the first.
    renotify: !!data.tag,
    data: { url: data.url || '/dashboard' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    timestamp: Date.now(),
  }
  // Always shown, even with the app open. iPhone and iPad require every push to show a
  // notification: after a few that show nothing, iOS cancels the device's subscription
  // without telling anyone, and alerts stop arriving.
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/dashboard'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Focus an existing tab on the same origin and navigate it.
        if ('focus' in client) {
          client.focus()
          if ('navigate' in client) { try { client.navigate(url) } catch (_e) {} }
          return
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    }),
  )
})
