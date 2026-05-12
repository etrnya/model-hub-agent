/**
 * GlobalState
 * Implements Optimistic Concurrency Control (OCC) for distributed agent tasks.
 * Ensures state consistency across multiple model calls.
 */
class GlobalState {
  constructor(initialData = {}) {
    this.data = {
      ...initialData,
      version: 1,
      change_log: []
    };
  }

  /**
   * Updates the state with version checking.
   * @param {Object} newData 
   * @param {number} expectedVersion 
   * @returns {boolean} Success
   */
  update(newData, expectedVersion) {
    if (this.data.version !== expectedVersion) {
      console.error(`[GlobalState] Version mismatch! Current: ${this.data.version}, Expected: ${expectedVersion}`);
      return false;
    }

    // Apply updates
    Object.assign(this.data, newData);
    
    // Increment version
    this.data.version += 1;
    
    // Log the change
    this.data.change_log.push({
      timestamp: Date.now(),
      version: this.data.version,
      changedFields: Object.keys(newData)
    });

    return true;
  }

  /**
   * Returns a snapshot of the current state.
   */
  getSnapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * Merges state (Fallback strategy for conflicts)
   * @param {Object} remoteData 
   */
  merge(remoteData) {
    console.warn("[GlobalState] Manual merge triggered due to conflict.");
    // Basic merge strategy: Remote wins for data, local increments version
    Object.assign(this.data, remoteData);
    this.data.version += 1;
    this.data.change_log.push({
      timestamp: Date.now(),
      version: this.data.version,
      note: "Merged conflict resolution"
    });
  }
}

module.exports = GlobalState;
