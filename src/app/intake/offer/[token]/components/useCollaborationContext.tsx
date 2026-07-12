import { createContext, useContext, useState, useEffect } from 'react'

export interface CollabUser {
  id: string
  name: string
  status: string
}

export interface ActivityEvent {
  id: string
  userName: string
  action: string
  timestamp: Date
}

interface CollaborationContextType {
  users: CollabUser[]
  activities: ActivityEvent[]
  logActivity: (action: string) => void
  isLocked: boolean
}

const CollaborationContext = createContext<CollaborationContextType>({
  users: [],
  activities: [],
  logActivity: () => {},
  isLocked: false,
})

export function CollaborationProvider({ children }: { children: React.ReactNode }) {
  const [users, setUsers] = useState<CollabUser[]>([])
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const [isLocked, setIsLocked] = useState(false)

  // Stubbed data for now to establish the foundation
  useEffect(() => {
    // In the future, this is where we subscribe to Supabase Realtime channel
    const me: CollabUser = { id: 'user-1', name: 'Farooq', status: 'editing' }
    setUsers([me])
  }, [])

  const logActivity = (action: string) => {
    setActivities(prev => [{
      id: Math.random().toString(),
      userName: 'Farooq',
      action,
      timestamp: new Date()
    }, ...prev].slice(0, 50)) // keep last 50
    // Future: broadcast to realtime channel
  }

  return (
    <CollaborationContext.Provider value={{ users, activities, logActivity, isLocked }}>
      {children}
    </CollaborationContext.Provider>
  )
}

export const useCollaboration = () => useContext(CollaborationContext)
