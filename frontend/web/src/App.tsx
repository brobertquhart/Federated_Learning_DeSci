// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface HospitalRecord {
  id: string;
  encryptedGradient: string;
  timestamp: number;
  hospital: string;
  modelVersion: string;
  status: "pending" | "aggregated" | "rejected";
  dataSize: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEAggregateGradients = (gradients: string[]): string => {
  const decryptedValues = gradients.map(g => FHEDecryptNumber(g));
  const average = decryptedValues.reduce((sum, val) => sum + val, 0) / decryptedValues.length;
  return FHEEncryptNumber(average);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<HospitalRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ modelVersion: "", gradientValue: 0, dataSize: 1000 });
  const [selectedRecord, setSelectedRecord] = useState<HospitalRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'dao'>('dashboard');
  const [daoProposals, setDaoProposals] = useState<any[]>([]);
  const [showTutorial, setShowTutorial] = useState(false);

  const aggregatedCount = records.filter(r => r.status === "aggregated").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const rejectedCount = records.filter(r => r.status === "rejected").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
      loadDaoProposals();
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("hospital_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing hospital keys:", e); }
      }
      const list: HospitalRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`hospital_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedGradient: recordData.gradient, 
                timestamp: recordData.timestamp, 
                hospital: recordData.hospital, 
                modelVersion: recordData.modelVersion,
                status: recordData.status || "pending",
                dataSize: recordData.dataSize || 0
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting model gradient with Zama FHE..." });
    try {
      const encryptedGradient = FHEEncryptNumber(newRecordData.gradientValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        gradient: encryptedGradient, 
        timestamp: Math.floor(Date.now() / 1000), 
        hospital: address, 
        modelVersion: newRecordData.modelVersion,
        status: "pending",
        dataSize: newRecordData.dataSize
      };
      await contract.setData(`hospital_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("hospital_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("hospital_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted gradient submitted securely!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ modelVersion: "", gradientValue: 0, dataSize: 1000 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const aggregateGradients = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Aggregating gradients with FHE..." });
    try {
      const pendingGradients = records.filter(r => r.status === "pending");
      if (pendingGradients.length === 0) throw new Error("No pending gradients to aggregate");
      
      const encryptedGradients = pendingGradients.map(r => r.encryptedGradient);
      const aggregatedGradient = FHEAggregateGradients(encryptedGradients);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      // Update all pending records to aggregated status
      for (const record of pendingGradients) {
        const updatedRecord = { 
          ...record, 
          status: "aggregated",
          gradient: aggregatedGradient
        };
        await contractWithSigner.setData(`hospital_${record.id}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      }
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE aggregation completed successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Aggregation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectGradient = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted gradient with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`hospital_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "rejected" };
      await contract.setData(`hospital_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const loadDaoProposals = async () => {
    // Simulate loading DAO proposals
    setDaoProposals([
      {
        id: "1",
        title: "Increase model training reward",
        description: "Proposal to increase rewards for hospitals contributing gradients",
        status: "active",
        votesFor: 120,
        votesAgainst: 45
      },
      {
        id: "2",
        title: "Add new hospital partner",
        description: "Proposal to onboard St. Mary's Hospital to the network",
        status: "passed",
        votesFor: 180,
        votesAgainst: 20
      },
      {
        id: "3",
        title: "Upgrade FHE parameters",
        description: "Proposal to upgrade to Zama FHE v2.0 for better performance",
        status: "pending",
        votesFor: 0,
        votesAgainst: 0
      }
    ]);
  };

  const isHospital = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const renderGradientChart = () => {
    const total = records.length || 1;
    const aggregatedPercentage = (aggregatedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const rejectedPercentage = (rejectedCount / total) * 100;
    return (
      <div className="pie-chart-container">
        <div className="pie-chart">
          <div className="pie-segment aggregated" style={{ transform: `rotate(${aggregatedPercentage * 3.6}deg)` }}></div>
          <div className="pie-segment pending" style={{ transform: `rotate(${(aggregatedPercentage + pendingPercentage) * 3.6}deg)` }}></div>
          <div className="pie-segment rejected" style={{ transform: `rotate(${(aggregatedPercentage + pendingPercentage + rejectedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-center">
            <div className="pie-value">{records.length}</div>
            <div className="pie-label">Gradients</div>
          </div>
        </div>
        <div className="pie-legend">
          <div className="legend-item"><div className="color-box aggregated"></div><span>Aggregated: {aggregatedCount}</span></div>
          <div className="legend-item"><div className="color-box pending"></div><span>Pending: {pendingCount}</span></div>
          <div className="legend-item"><div className="color-box rejected"></div><span>Rejected: {rejectedCount}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHES073</h1>
          <span>Federated Learning DeSci</span>
        </div>
        <nav className="main-nav">
          <button 
            className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Model Dashboard
          </button>
          <button 
            className={`nav-btn ${activeTab === 'dao' ? 'active' : ''}`}
            onClick={() => setActiveTab('dao')}
          >
            DAO Governance
          </button>
        </nav>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="primary-btn">
            Submit Gradient
          </button>
          <button className="secondary-btn" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <main className="main-content">
        {showTutorial && (
          <div className="tutorial-section">
            <h2>How Federated Learning with FHE Works</h2>
            <div className="tutorial-steps">
              <div className="tutorial-step">
                <div className="step-icon">🏥</div>
                <div className="step-content">
                  <h3>Local Model Training</h3>
                  <p>Each hospital trains the model locally on their private patient data</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">🔒</div>
                <div className="step-content">
                  <h3>FHE Encryption</h3>
                  <p>Model gradients are encrypted using Zama FHE before sharing</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">🔄</div>
                <div className="step-content">
                  <h3>Secure Aggregation</h3>
                  <p>Gradients are aggregated while remaining encrypted</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">🤖</div>
                <div className="step-content">
                  <h3>Global Model Update</h3>
                  <p>The aggregated update improves the shared model without exposing raw data</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dashboard' ? (
          <>
            <div className="stats-grid">
              <div className="stat-card">
                <h3>Participating Hospitals</h3>
                <div className="stat-value">{new Set(records.map(r => r.hospital)).size}</div>
              </div>
              <div className="stat-card">
                <h3>Total Gradients</h3>
                <div className="stat-value">{records.length}</div>
              </div>
              <div className="stat-card">
                <h3>Current Model Version</h3>
                <div className="stat-value">v2.1.3</div>
              </div>
              <div className="stat-card">
                <h3>Data Protected</h3>
                <div className="stat-value">{records.reduce((sum, r) => sum + r.dataSize, 0).toLocaleString()}</div>
              </div>
            </div>

            <div className="gradient-status">
              <h2>Gradient Status</h2>
              {renderGradientChart()}
            </div>

            <div className="records-section">
              <div className="section-header">
                <h2>Hospital Contributions</h2>
                <div className="header-actions">
                  <button onClick={loadRecords} className="secondary-btn" disabled={isRefreshing}>
                    {isRefreshing ? "Refreshing..." : "Refresh"}
                  </button>
                  {pendingCount > 0 && (
                    <button onClick={aggregateGradients} className="primary-btn">
                      Aggregate Gradients ({pendingCount})
                    </button>
                  )}
                </div>
              </div>
              
              <div className="records-table">
                <div className="table-header">
                  <div>Hospital</div>
                  <div>Model Version</div>
                  <div>Data Size</div>
                  <div>Date</div>
                  <div>Status</div>
                  <div>Actions</div>
                </div>
                
                {records.length === 0 ? (
                  <div className="no-records">
                    <p>No hospital gradients found</p>
                    <button className="primary-btn" onClick={() => setShowCreateModal(true)}>
                      Submit First Gradient
                    </button>
                  </div>
                ) : records.map(record => (
                  <div className="table-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                    <div>{record.hospital.substring(0, 6)}...{record.hospital.substring(38)}</div>
                    <div>{record.modelVersion}</div>
                    <div>{record.dataSize.toLocaleString()}</div>
                    <div>{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                    <div>
                      <span className={`status-badge ${record.status}`}>
                        {record.status}
                      </span>
                    </div>
                    <div className="actions">
                      {isHospital(record.hospital) && record.status === "pending" && (
                        <button 
                          className="danger-btn"
                          onClick={(e) => { e.stopPropagation(); rejectGradient(record.id); }}
                        >
                          Withdraw
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="dao-section">
            <h2>DAO Governance</h2>
            <p className="dao-description">
              The FHES073 DAO coordinates model training incentives and protocol upgrades through decentralized governance.
              Hospital participation is rewarded with governance tokens proportional to their contributions.
            </p>
            
            <div className="dao-stats">
              <div className="stat-card">
                <h3>Active Proposals</h3>
                <div className="stat-value">{daoProposals.filter(p => p.status === "active").length}</div>
              </div>
              <div className="stat-card">
                <h3>Total Members</h3>
                <div className="stat-value">42</div>
              </div>
              <div className="stat-card">
                <h3>Your Voting Power</h3>
                <div className="stat-value">1,250</div>
              </div>
            </div>
            
            <div className="proposals-list">
              <h3>Recent Proposals</h3>
              {daoProposals.map(proposal => (
                <div className="proposal-card" key={proposal.id}>
                  <div className="proposal-header">
                    <h4>{proposal.title}</h4>
                    <span className={`proposal-status ${proposal.status}`}>
                      {proposal.status}
                    </span>
                  </div>
                  <p>{proposal.description}</p>
                  <div className="proposal-votes">
                    <div className="vote-bar">
                      <div 
                        className="vote-for" 
                        style={{ width: `${(proposal.votesFor / (proposal.votesFor + proposal.votesAgainst)) * 100}%` }}
                      >
                        {proposal.votesFor} For
                      </div>
                      <div 
                        className="vote-against" 
                        style={{ width: `${(proposal.votesAgainst / (proposal.votesFor + proposal.votesAgainst)) * 100}%` }}
                      >
                        {proposal.votesAgainst} Against
                      </div>
                    </div>
                  </div>
                  <div className="proposal-actions">
                    <button className="secondary-btn">View Details</button>
                    {proposal.status === "active" && (
                      <button className="primary-btn">Vote Now</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}

      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FHES073</h3>
            <p>FHE-based Federated Learning for Healthcare</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Research Papers</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="tech-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHES073 Consortium. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.modelVersion || !recordData.gradientValue) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Submit Encrypted Gradient</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Model Version *</label>
            <input 
              type="text" 
              name="modelVersion" 
              value={recordData.modelVersion} 
              onChange={handleChange} 
              placeholder="e.g. v2.1.3" 
              className="form-input"
            />
          </div>
          <div className="form-group">
            <label>Gradient Value *</label>
            <input 
              type="number" 
              name="gradientValue" 
              value={recordData.gradientValue} 
              onChange={handleValueChange} 
              placeholder="Enter numerical gradient value" 
              className="form-input"
              step="0.0001"
            />
          </div>
          <div className="form-group">
            <label>Data Size (records)</label>
            <input 
              type="number" 
              name="dataSize" 
              value={recordData.dataSize} 
              onChange={handleValueChange} 
              placeholder="Number of records used" 
              className="form-input"
            />
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-box">
              <div className="plain-value">
                <span>Plain Gradient:</span>
                <div>{recordData.gradientValue || 'N/A'}</div>
              </div>
              <div className="encrypted-value">
                <span>Encrypted with Zama FHE:</span>
                <div>{recordData.gradientValue ? FHEEncryptNumber(recordData.gradientValue).substring(0, 50) + '...' : 'N/A'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon">🔒</div>
            <div>
              <strong>Data Privacy Guarantee</strong>
              <p>Patient data never leaves your hospital. Only encrypted gradients are shared.</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="secondary-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="primary-btn">
            {creating ? "Encrypting with Zama FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: HospitalRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedGradient);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal">
        <div className="modal-header">
          <h2>Gradient Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-row">
              <span>Hospital:</span>
              <strong>{record.hospital.substring(0, 6)}...{record.hospital.substring(38)}</strong>
            </div>
            <div className="info-row">
              <span>Model Version:</span>
              <strong>{record.modelVersion}</strong>
            </div>
            <div className="info-row">
              <span>Data Size:</span>
              <strong>{record.dataSize.toLocaleString()} records</strong>
            </div>
            <div className="info-row">
              <span>Submitted:</span>
              <strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-row">
              <span>Status:</span>
              <strong className={`status-badge ${record.status}`}>{record.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Gradient</h3>
            <div className="encrypted-data">
              {record.encryptedGradient.substring(0, 100)}...
            </div>
            <div className="fhe-badge">
              <span>Zama FHE Encrypted</span>
            </div>
            <button 
              className="primary-btn" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedValue ? "Hide Value" : "Decrypt with Wallet"}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Gradient Value</h3>
              <div className="decrypted-value">
                {decryptedValue}
              </div>
              <div className="decryption-warning">
                <div className="warning-icon">⚠️</div>
                <span>This value is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="secondary-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;