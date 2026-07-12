import { useCollaboration } from './useCollaborationContext'
import { Users, History } from 'lucide-react'
import { useState } from 'react'

export function CollaborationStatus() {
  const { users, activities, isLocked } = useCollaboration()
  const [showActivity, setShowActivity] = useState(false)

  const otherUsers = users.filter(u => u.name !== 'Farooq')

  return (
    <div className="relative inline-flex items-center gap-3">
      {isLocked && (
        <div className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs text-amber-300">Locked by {otherUsers[0]?.name || 'someone'}</span>
        </div>
      )}

      {otherUsers.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-white/50">
          <Users className="w-3.5 h-3.5" />
          {otherUsers.map(u => (
            <span key={u.id} className="text-white/80">{u.name} {u.status}</span>
          ))}
        </div>
      )}

      <button 
        onClick={() => setShowActivity(!showActivity)}
        className="p-1.5 rounded-lg text-white/50 hover:bg-white/10 hover:text-white transition-colors"
        title="Activity Feed"
      >
        <History className="w-4 h-4" />
      </button>

      {showActivity && (
        <div className="absolute top-full right-0 mt-2 w-64 bg-[#1a1a24] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-white/10 bg-white/5 text-xs font-semibold text-white/80">
            Recent Activity
          </div>
          <div className="max-h-60 overflow-y-auto">
            {activities.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-white/30">No recent activity</div>
            ) : (
              <ul className="divide-y divide-white/5">
                {activities.map(act => (
                  <li key={act.id} className="px-3 py-2 flex flex-col gap-0.5">
                    <span className="text-xs text-white/90 font-medium">{act.action}</span>
                    <span className="text-[10px] text-white/40">{act.userName} • {act.timestamp.toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
