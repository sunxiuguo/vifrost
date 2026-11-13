import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive, effect, stop } from 'vue'
import { Model, configure } from '@vifrost/client'
class Appointment extends Model {
  static resource = 'appointment'
  static relations = ['staffMember']
}
afterEach(() => { configure({ baseUrl: 'https://synthetic.invalid' }) })
describe('reactive model relation aliases', () => {
  it('preserves reactive updates when save first returns a canonical relation', async () => {
    configure({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(JSON.stringify({ id: 1, staffMember: { id: 3 } }), { headers: { 'content-type': 'application/json' } }) })
    const row = reactive(Appointment.instantiate({ id: 1 }))
    let observed: unknown
    const runner = effect(() => { observed = row.staffMember })
    try { await row.save(); expect(observed).toEqual({ id: 3 }) } finally { stop(runner) }
  })
  it.each(['staff_member', 'staffMember'])('updates both reactive views after save with %s wire source', async source => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 1, staff_member: { id: 3 } }), { headers: { 'content-type': 'application/json' } }))
    configure({ baseUrl: 'https://synthetic.invalid', fetch })
    const row = reactive(Appointment.instantiate({ id: 1, [source]: { id: 2 } }))
    let canonical: unknown; let serialized: unknown
    const runner = effect(() => { canonical = row.staffMember; serialized = row.staff_member })
    try {
      expect(canonical).toEqual({ id: 2 }); expect(serialized).toEqual({ id: 2 })
      await row.save()
      expect(canonical).toEqual({ id: 3 }); expect(serialized).toEqual({ id: 3 })
      row.staffMember = { id: 4 }
      expect(canonical).toEqual({ id: 4 }); expect(serialized).toEqual({ id: 4 })
      row.staff_member = null
      expect(canonical).toBe(null); expect(serialized).toBe(null)
    } finally { stop(runner) }
  })
})
