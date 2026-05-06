import { useStore } from '../store'
import { BullBearBoard } from '../components/BullBearBoard'

export function CommodityPage() {
  const { signals } = useStore()
  const filtered = signals.filter(s => s.type === 'COMMODITY')
  return <BullBearBoard signals={filtered} />
}
