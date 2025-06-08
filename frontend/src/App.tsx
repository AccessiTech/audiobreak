import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import { Tabs, Tab, Table, Button, Form, Alert, Spinner, Collapse, ProgressBar } from 'react-bootstrap';

const MEDIA_OPTIONS = [
  { label: 'Audio', value: 'audio' },
  { label: 'Images', value: 'img' },
  { label: 'PDF', value: 'pdf' },
  { label: 'SVG', value: 'svg' },
  { label: 'Video', value: 'video' },
];

function App() {
  const [url, setUrl] = useState('');
  const [metadata, setMetadata] = useState<any | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selector, setSelector] = useState('');
  // Select all media types by default, sorted alphabetically
  const [mediaTypes, setMediaTypes] = useState<string[]>(MEDIA_OPTIONS.map(opt => opt.value));
  const [mediaAssets, setMediaAssets] = useState<{url: string, type: string}[]>([]);
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zipName, setZipName] = useState('media-assets.zip');
  const [selectedPaginationLinks, setSelectedPaginationLinks] = useState<Set<string>>(new Set());
  // Set the first tab as active by default, based on sorted MEDIA_OPTIONS
  const [activeTab, setActiveTab] = useState<string>(MEDIA_OPTIONS[0].value);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<any>(null);
  const [downloadReady, setDownloadReady] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleMediaTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = Array.from(e.target.selectedOptions, option => option.value);
    setMediaTypes(selected);
    // If the current tab is not in the new selection, switch to the first selected
    if (selected.length > 0 && !selected.includes(activeTab)) {
      setActiveTab(selected[0]);
    }
  };

  const handleAssetCheck = (url: string) => {
    setSelectedAssets(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  // Tabbed select-all logic
  const assetsByType = mediaTypes.reduce((acc, type) => {
    acc[type] = mediaAssets.filter(a => a.type === type);
    return acc;
  }, {} as Record<string, {url: string, type: string}[]>);

  const allCheckedByType = (type: string) => assetsByType[type].length > 0 && assetsByType[type].every(asset => selectedAssets.has(asset.url));
  const handleSelectAllByType = (type: string) => {
    if (allCheckedByType(type)) {
      setSelectedAssets(prev => {
        const next = new Set(prev);
        assetsByType[type].forEach(asset => next.delete(asset.url));
        return next;
      });
    } else {
      setSelectedAssets(prev => {
        const next = new Set(prev);
        assetsByType[type].forEach(asset => next.add(asset.url));
        return next;
      });
    }
  };

  // Helper for pagination link selection
  // Always include the initial URL in the list of detected pagination links
  const detectedPaginationLinks = metadata?.pagination_similar_links
    ? [url, ...metadata.pagination_similar_links.filter((link: string) => link !== url)]
    : [];
  const allPaginationChecked = detectedPaginationLinks.length > 0 && detectedPaginationLinks.every((link: string) => selectedPaginationLinks.has(link));
  const handlePaginationSelectAll = () => {
    if (allPaginationChecked) {
      setSelectedPaginationLinks(new Set());
    } else {
      setSelectedPaginationLinks(new Set(detectedPaginationLinks));
    }
  };
  const handlePaginationCheck = (link: string) => {
    setSelectedPaginationLinks(prev => {
      const next = new Set(prev);
      if (next.has(link)) next.delete(link);
      else next.add(link);
      return next;
    });
  };

  const handleScrape = async () => {
    setLoading(true);
    setError('');
    setResults([]);
    setMediaAssets([]);
    setSelectedAssets(new Set());
    setActiveTab(mediaTypes[0] || ''); // Reset active tab to first selected type
    // Clear previous pagination links selection as well
    setSelectedPaginationLinks(new Set());
    try {
      const response = await fetch('/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          keyword: keyword || undefined,
          selector: selector || undefined,
          media_types: mediaTypes,
          pagination_links: selectedPaginationLinks.size > 0 ? Array.from(selectedPaginationLinks) : undefined,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setResults(data.results || []);
      setMediaAssets(data.media_assets || []);
    } catch (err: any) {
      setError(err.message || 'Error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Update: Use the correct endpoint for starting the download job
  const handleDownload = async () => {
    if (selectedAssets.size === 0) return;
    setLoading(true);
    setError('');
    setDownloadProgress(null);
    setDownloadReady(false);
    setDownloadJobId(null);
    try {
      const response = await fetch('/start-download-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: Array.from(selectedAssets),
          zip_name: zipName || 'media-assets.zip',
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const jobId = data.job_id;
      setDownloadJobId(jobId);
      // Step 2: Listen for progress via SSE
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      const es = new window.EventSource(`/download-progress/${jobId}`);
      eventSourceRef.current = es;
      es.onmessage = (event) => {
        try {
          const prog = JSON.parse(event.data);
          setDownloadProgress(prog);
          if (prog.ready) {
            setDownloadReady(true);
            es.close();
            eventSourceRef.current = null;
          }
        } catch {}
      };
      es.onerror = () => {
        setError('Error receiving progress updates.');
        es.close();
        eventSourceRef.current = null;
      };
    } catch (err: any) {
      setError(err.message || 'Download failed');
      setLoading(false);
    }
  };

  // Step 3: When downloadReady, show a download link instead of auto-downloading
  useEffect(() => {
    if (downloadReady && downloadJobId && downloadProgress && downloadProgress.zip_size > 0) {
      setLoading(false);
      setError('');
      // Do not auto-download. Show a download link instead.
    }
    // eslint-disable-next-line
  }, [downloadReady, downloadJobId, downloadProgress]);

  // New: Fetch metadata for initial configuration
  const handleFetchMetadata = async () => {
    setMetaLoading(true);
    setMetaError('');
    setMetadata(null);
    setResults([]);
    setMediaAssets([]);
    setSelectedAssets(new Set());
    setError('');
    try {
      const response = await fetch('/scrape-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setMetadata(data);
    } catch (err: any) {
      setMetaError(err.message || 'Error fetching metadata');
    } finally {
      setMetaLoading(false);
    }
  };

  // Set zipName to page title if available in metadata
  useEffect(() => {
    if (metadata && metadata.title) {
      // Sanitize title for filename
      // const safeTitle = metadata.title;
      setZipName(metadata.title + '.zip');
    } else {
      setZipName('media-assets.zip');
    }
  }, [metadata]);

  return (
    <div className="container mt-4">
      <h1 className="mb-4">AudioBreak Web Scraper</h1>
      {/* Initial metadata fetch UI */}
      <Form className="form mb-3" onSubmit={e => { e.preventDefault(); handleFetchMetadata(); }}>
        <div className="row mb-3">
          <div className="col">
            <Form.Control
              type="text"
              name="scrape-url"
              placeholder="Enter site URL to scrape"
              value={url}
              onChange={e => setUrl(e.target.value)}
              autoComplete="url"
            />
          </div>
          <div className="col-auto">
            <Button type="submit" variant="info" disabled={metaLoading || !url}>
              {metaLoading ? <Spinner size="sm" animation="border" /> : 'Detect Metadata'}
            </Button>
          </div>
        </div>
      </Form>
      {metaError && <Alert variant="danger">{metaError}</Alert>}
      {/* Show metadata suggestions if available */}
      {metadata && (
        <div className="mb-4">
          {metadata.title && <h4>Page Title: <span className="text-secondary">{metadata.title}</span></h4>}
          {metadata.pagination_candidates?.length > 0 && (
            <div className="mb-2">
              <strong>Detected Pagination Selectors:</strong>
              <ul>
                {metadata.pagination_candidates.map((c: any, idx: number) => (
                  <li key={idx}>
                    <code>{c.selector}</code> ({c.count} found)
                    {c.examples?.length > 0 && (
                      <span> e.g. {c.examples.map((ex: string, i: number) => <span key={i}><a href={ex} target="_blank" rel="noopener noreferrer">{ex}</a>{i < c.examples.length - 1 ? ', ' : ''}</span>)} </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {metadata.main_selectors?.length > 0 && (
            <div className="mb-2">
              <strong>Suggested Main Content Selectors:</strong> {metadata.main_selectors.map((sel: string) => <code key={sel} style={{ marginRight: 8 }}>{sel}</code>)}
            </div>
          )}
          {metadata.media_types?.length > 0 && (
            <div className="mb-2">
              <strong>Detected Media Types:</strong> {metadata.media_types.map((mt: string) => <code key={mt} style={{ marginRight: 8 }}>{mt}</code>)}
            </div>
          )}
        </div>
      )}
      {/* Detected Pagination Links selection table */}
      {metadata && detectedPaginationLinks.length > 0 && (
        <div className="mb-4">
          <h5>Detected Pagination Links</h5>
          <Table bordered hover striped style={{ maxWidth: 800 }}>
            <thead className="table-light">
              <tr>
                <th style={{ width: 40 }}>
                  <Form.Check
                    type="checkbox"
                    checked={allPaginationChecked}
                    onChange={handlePaginationSelectAll}
                  />
                </th>
                <th>URL</th>
              </tr>
            </thead>
            <tbody>
              {detectedPaginationLinks.map((link: string) => (
                <tr key={link}>
                  <td>
                    <Form.Check
                      type="checkbox"
                      checked={selectedPaginationLinks.has(link)}
                      onChange={() => handlePaginationCheck(link)}
                    />
                  </td>
                  <td>
                    <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {/* Only show the full scrape form if metadata is loaded */}
      {metadata && (
        <Form className="form mb-3" onSubmit={e => { e.preventDefault(); handleScrape(); }}>
          <div className="row mb-3">
            <div className="col">
              <Form.Control
                type="text"
                name="scrape-url"
                placeholder="Enter site URL to scrape"
                value={url}
                onChange={e => setUrl(e.target.value)}
                autoComplete="url"
                disabled
              />
            </div>
            <div className="col-auto">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                aria-controls="advanced-options"
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
              </Button>
            </div>
          </div>
          <Collapse in={showAdvanced}>
            <div id="advanced-options">
              <div className="row mb-3">
                <div className="col">
                  <Form.Control
                    type="text"
                    name="keyword-filter"
                    placeholder="Optional keyword filter"
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="col">
                  <Form.Control
                    type="text"
                    name="query-selector"
                    placeholder="Optional query selector (e.g. .my-class, #main)"
                    value={selector}
                    onChange={e => setSelector(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="col">
                  <Form.Label>Media types to scrape:</Form.Label>
                  <Form.Select multiple value={mediaTypes} onChange={handleMediaTypeChange}>
                    {MEDIA_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </Form.Select>
                </div>
              </div>
            </div>
          </Collapse>
          <Button type="submit" variant="primary" disabled={loading || !url}>
            {loading ? <Spinner size="sm" animation="border" /> : 'Scrape Site'}
          </Button>
        </Form>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
      {/* Only show text results if no media types are selected */}
      {mediaTypes.length === 0 && (
        <div className="results">
          {results.length > 0 && <h2>Results</h2>}
          <ul className="list-group">
            {results.map((text, idx) => (
              <li key={idx} className="list-group-item">{text}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Show media assets UI if any media type is selected */}
      {mediaTypes.length > 0 && (
        <div className="media-assets">
          {mediaAssets.length > 0 && <h2>Media Assets</h2>}
          {/* Tabbed media asset selection */}
          {mediaAssets.length > 0 && (
            <Tabs
              id="media-type-tabs"
              activeKey={activeTab}
              onSelect={k => setActiveTab(k || mediaTypes[0])}
              className="mb-3"
              fill
              variant="tabs"
              mountOnEnter
              unmountOnExit
            >
              {mediaTypes.map(type => {
                const label = MEDIA_OPTIONS.find(opt => opt.value === type)?.label || type;
                const count = assetsByType[type]?.length || 0;
                return (
                  <Tab eventKey={type} title={`${label} (${count})`} key={type}>
                    <Table bordered hover striped style={{ marginBottom: '1rem' }}>
                      <thead className="table-light">
                        <tr>
                          <th style={{ width: 40 }}>
                            <Form.Check
                              type="checkbox"
                              checked={allCheckedByType(type)}
                              onChange={() => handleSelectAllByType(type)}
                            />
                          </th>
                          <th>URL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {assetsByType[type].map((asset) => (
                          <tr key={asset.url}>
                            <td>
                              <Form.Check
                                type="checkbox"
                                checked={selectedAssets.has(asset.url)}
                                onChange={() => handleAssetCheck(asset.url)}
                              />
                            </td>
                            <td>
                              <a href={asset.url} target="_blank" rel="noopener noreferrer">{asset.url}</a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </Tab>
                );
              })}
            </Tabs>
          )}
          {mediaAssets.length > 0 && (
            <Form className="container" style={{ marginTop: '1rem' }} onSubmit={e => { e.preventDefault(); handleDownload(); }}>
              <div className="row g-2">
                <div className="col-8">
                  <Form.Control
                    type="text"
                    name="zip-file-name"
                    value={zipName}
                    onChange={e => setZipName(e.target.value)}
                    placeholder="ZIP file name (e.g. myfiles.zip)"
                  />
                </div>
                <div className="col-4 d-grid">
                  <Button variant="success" type="submit" disabled={selectedAssets.size === 0 || loading}>
                    Download ZIP
                  </Button>
                </div>
              </div>
            </Form>
          )}
          {downloadProgress && (
            <div className="mb-3">
              <strong>Download Progress:</strong>
              <div>
                {/* Progress bar for file downloads */}
                {downloadProgress.total > 0 && (
                  <ProgressBar
                    now={
                      downloadProgress.status === 'Preparing ZIP...' || downloadProgress.status === 'ready'
                        ? 100
                        : Math.round((downloadProgress.current / downloadProgress.total) * 100)
                    }
                    variant={
                      downloadProgress.status === 'Preparing ZIP...' || downloadProgress.status === 'ready'
                        ? 'success'
                        : 'info'
                    }
                    animated={downloadProgress.status !== 'Preparing ZIP...' && downloadProgress.status !== 'ready'}
                    striped
                    style={{ marginBottom: 8 }}
                  />
                )}
                {/* Status text */}
                {downloadProgress.status === 'Preparing ZIP...'
                  ? <div><Spinner size="sm" animation="border" className="me-2" />Preparing ZIP...</div>
                  : downloadProgress.status && downloadProgress.status !== 'ready'
                    ? <span>{downloadProgress.status}</span>
                    : null}
                {downloadProgress.current !== undefined && downloadProgress.total !== undefined && downloadProgress.status !== 'Preparing ZIP...'
                  ? <span> ({downloadProgress.current} of {downloadProgress.total} files)</span>
                  : null}
                {downloadProgress.zip_size > 0 && (
                  <span> | ZIP size: {(downloadProgress.zip_size / 1024 / 1024).toFixed(2)} MB</span>
                )}
              </div>
              {/* Show manual download link if ready */}
              {downloadReady && downloadJobId && downloadProgress.zip_size > 0 && (
                <div className="mt-2">
                  <a
                    href={`/download-zip/${downloadJobId}`}
                    className="btn btn-primary"
                    download={zipName}
                  >
                    Click here to download ZIP ({(downloadProgress.zip_size / 1024 / 1024).toFixed(2)} MB)
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Reset Button at the very bottom of the page, only show after metadata is loaded */}
      {metadata && (
        <div className="d-flex justify-content-center mt-4">
          <Button
            variant="outline-danger"
            onClick={async () => {
              // If a download job exists and is not ready, or is ready but not downloaded, delete it on the backend
              if (downloadJobId && downloadProgress && !downloadReady) {
                try {
                  await fetch(`/download-zip/${downloadJobId}`, { method: 'DELETE' });
                } catch {}
              }
              // Reset all state to initial values
              setUrl('');
              setMetadata(null);
              setMetaLoading(false);
              setMetaError('');
              setKeyword('');
              setSelector('');
              setMediaTypes(MEDIA_OPTIONS.map(opt => opt.value));
              setMediaAssets([]);
              setSelectedAssets(new Set());
              setResults([]);
              setLoading(false);
              setError('');
              setZipName('media-assets.zip');
              setSelectedPaginationLinks(new Set());
              setActiveTab(MEDIA_OPTIONS[0].value);
              setShowAdvanced(false);
              setDownloadJobId(null);
              setDownloadProgress(null);
              setDownloadReady(false);
              if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
              }
            }}
          >
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}

export default App;
