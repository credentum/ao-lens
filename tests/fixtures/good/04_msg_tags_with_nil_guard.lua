-- GOOD: msg.Tags accessed with proper nil guard
-- NotExpected: MSG_TAGS_NO_NIL_GUARD

State = State or { History = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  local entry = {
    timestamp = msg.Timestamp,
    generation = msg.Tags and msg.Tags.Generation or 0,  -- Proper nil guard
    from = msg.From
  }
  table.insert(State.History, entry)
end)
