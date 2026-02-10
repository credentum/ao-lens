-- BAD: State overwritten on every replay without 'or' guard
-- Expected: STATE_OVERWRITE_ON_REPLAY (critical)

State = {
  Owner = ao.env.Process.Owner,
  Counter = 0
}

Handlers.add("Increment", { Action = "Increment" }, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  State.Counter = State.Counter + 1
  ao.send({ Target = msg.From, Data = tostring(State.Counter) })
end)
