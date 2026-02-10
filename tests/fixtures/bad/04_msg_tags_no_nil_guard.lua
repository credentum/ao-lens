-- BAD: Accessing msg.Tags.X without checking if msg.Tags exists
-- Expected: MSG_TAGS_NO_NIL_GUARD (high) at line 9

State = State or { History = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  local entry = {
    timestamp = msg.Timestamp,
    generation = msg.Tags.Generation,  -- NO nil guard for msg.Tags!
    from = msg.From
  }
  table.insert(State.History, entry)
end)
