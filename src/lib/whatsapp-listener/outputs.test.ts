import { describe, expect, it } from 'vitest'
import { exactIlike, isClientOutput, outputCaption, outputFileName, outputsToChatOn } from './outputs'

describe('final outputs into the client channel', () => {
  const photo = { fromCirqle: true, type: 'image', mediaPath: 'whatsapp-chat/2026-11/x.jpg', clientName: 'Sea Star Supermarket' }
  it('takes only photos Cirqle sent in a client chat', () => {
    expect(isClientOutput(photo)).toBe(true)
    expect(isClientOutput({ ...photo, fromCirqle: false })).toBe(false)      // the client's own photo
    expect(isClientOutput({ ...photo, type: 'ptt' })).toBe(false)            // a voice note
    expect(isClientOutput({ ...photo, mediaPath: null })).toBe(false)        // could not be kept
    expect(isClientOutput({ ...photo, clientName: ' ' })).toBe(false)        // an internal chat
  })
  it('is on unless switched off', () => {
    expect(outputsToChatOn({})).toBe(true)
    expect(outputsToChatOn({ whatsapp_listener_outputs_to_chat: 'off' })).toBe(false)
    expect(outputsToChatOn({ whatsapp_listener_outputs_to_chat: 'on' })).toBe(true)
  })
  it('words the message and names the file', () => {
    expect(outputCaption('', 'CQID004')).toBe('Sent to the client on WhatsApp by CQID004')
    expect(outputCaption('Final poster ', null)).toBe('Sent to the client on WhatsApp\nFinal poster')
    expect(outputFileName('whatsapp-chat/2026-11/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed-Friday-offer.jpg', '2026-11-28T10:00:00Z')).toBe('Friday-offer.jpg')
    expect(outputFileName('whatsapp-chat/2026-11/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed-image.jpg', '2026-11-28T10:00:00Z')).toBe('whatsapp-2026-11-28.jpg')
  })
  it('matches a client name exactly', () => {
    expect(exactIlike(' 50%_Off ')).toBe('50\\%\\_Off')
  })
})
