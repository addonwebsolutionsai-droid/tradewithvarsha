import { useStore } from '../store'
import { BullBearBoard } from '../components/BullBearBoard'

export function SwingPage() {
  const { signals } = useStore()
  const filtered = signals.filter(s => s.type === 'SWING')
  return <BullBearBoard signals={filtered} />
}
