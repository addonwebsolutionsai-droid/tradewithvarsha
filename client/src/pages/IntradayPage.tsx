import { useStore } from '../store'
import { BullBearBoard } from '../components/BullBearBoard'

export function IntradayPage() {
  const { signals } = useStore()
  const filtered = signals.filter(s => s.type === 'INTRADAY')
  return <BullBearBoard signals={filtered} />
}
