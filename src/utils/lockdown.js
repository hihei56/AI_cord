let lockedDown = false;

function isLockedDown() {
  return lockedDown;
}

function setLockdown(value) {
  lockedDown = value;
}

module.exports = { isLockedDown, setLockdown };
