-- GOOD: Using msg.Timestamp instead of os.time()
-- NotExpected: OS_TIME_USAGE

State = State or { History = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  local entry = {
    timestamp = msg.Timestamp,  -- CORRECT: deterministic timestamp from MU
    data = msg.Data
  }
  table.insert(State.History, entry)
end)
