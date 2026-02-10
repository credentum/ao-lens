-- BAD: Using os.time() which is non-deterministic
-- Expected: OS_TIME_USAGE (high) at line 8

State = State or { History = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  local entry = {
    timestamp = os.time(),  -- NON-DETERMINISTIC! Use msg.Timestamp
    data = msg.Data
  }
  table.insert(State.History, entry)
end)
