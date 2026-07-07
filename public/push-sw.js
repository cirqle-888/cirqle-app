/* Cirqle push service worker. Registered by the PushToggle component.
   Shows a notification on 'push' and focuses/open the app on click. */

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (_e) { data = {} }
  const title = data.title || 'Cirqle'
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/dashboard' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }
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
