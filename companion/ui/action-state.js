/* Explicit companion-state -> animation contract. No random action selection. */
const companionActions = (() => {
  const reactions = { pet: 'Nod', berry: 'Eat', completed: 'Pose', milestone: 'Pose', level_up: 'Pose', evolution_ready: 'Pose', badge: 'Pose', evolve: 'Idle',
    input_needed: 'Idle', stopped: 'Idle', low_allowance: 'Idle', limit_reached: 'Idle' };
  function select(activity, reaction, idleMilliseconds) {
    if (reactions[reaction]) return reactions[reaction];
    if (activity === 'working') return 'Walk';
    if (activity === 'idle' && idleMilliseconds >= 10000) return 'Sleep';
    return 'Idle';
  }
  function effect(activity, reaction) {
    if (reaction === 'pet') return 'heart';
    if (reaction === 'berry') return 'berry';
    if (['completed', 'milestone', 'evolve', 'level_up', 'evolution_ready', 'badge'].includes(reaction)) return 'sparkle';
    if (activity === 'waiting' || ['input_needed', 'stopped', 'low_allowance', 'limit_reached'].includes(reaction)) return 'question';
    return null;
  }
  return { select, effect };
})();
if (typeof module !== 'undefined') module.exports = companionActions;
