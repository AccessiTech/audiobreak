from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import requests
from bs4 import BeautifulSoup
import io
import zipfile
import os
import tempfile
import threading
import time
import uuid
import json
import datetime

app = FastAPI()

# Allow CORS for frontend on localhost:5173
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"] ,
    allow_headers=["*"]
)

class ScrapeRequest(BaseModel):
    url: str
    keyword: Optional[str] = None
    selector: Optional[str] = None
    media_types: Optional[list[str]] = None
    follow_pagination: Optional[bool] = False
    pagination_selector: Optional[str] = None
    pagination_type: Optional[str] = "next"  # "next" or "list"
    pagination_links: Optional[list[str]] = None  # NEW: explicit pagination links

@app.post("/scrape")
def scrape_site(request: ScrapeRequest):
    def scrape_single(url):
        try:
            response = requests.get(url)
            response.raise_for_status()
        except Exception as e:
            return None, None, str(e), []
        soup = BeautifulSoup(response.text, "html.parser")
        # Use selector if provided, else default to paragraphs
        if request.selector:
            elements = soup.select(request.selector)
        else:
            elements = soup.find_all('p')
        # Filter by keyword if provided
        if request.keyword:
            results = [el.text for el in elements if request.keyword.lower() in el.text.lower()]
        else:
            results = [el.text for el in elements]
        # Scrape media assets if requested
        media_assets = []
        from urllib.parse import urlparse, urlunparse
        if request.media_types:
            for mtype in request.media_types:
                if mtype == 'img':
                    for tag in soup.find_all('img'):
                        src = tag.get('src')
                        if src:
                            # Remove query string from URL
                            parsed = urlparse(src)
                            clean_src = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_src, 'type': 'img'})
                if mtype == 'audio':
                    for tag in soup.find_all('audio'):
                        src = tag.get('src')
                        if src:
                            parsed = urlparse(src)
                            clean_src = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_src, 'type': 'audio'})
                    for tag in soup.find_all('source'):
                        if tag.parent.name == 'audio':
                            src = tag.get('src')
                            if src:
                                parsed = urlparse(src)
                                clean_src = urlunparse(parsed._replace(query=''))
                                media_assets.append({'url': clean_src, 'type': 'audio'})
                if mtype == 'video':
                    for tag in soup.find_all('video'):
                        src = tag.get('src')
                        if src:
                            parsed = urlparse(src)
                            clean_src = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_src, 'type': 'video'})
                    for tag in soup.find_all('source'):
                        if tag.parent.name == 'video':
                            src = tag.get('src')
                            if src:
                                parsed = urlparse(src)
                                clean_src = urlunparse(parsed._replace(query=''))
                                media_assets.append({'url': clean_src, 'type': 'video'})
                if mtype == 'pdf':
                    for tag in soup.find_all('a', href=True):
                        href = tag['href']
                        if href.lower().endswith('.pdf'):
                            parsed = urlparse(href)
                            clean_href = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_href, 'type': 'pdf'})
                if mtype == 'svg':
                    for tag in soup.find_all('img'):
                        src = tag.get('src')
                        if src and src.lower().endswith('.svg'):
                            parsed = urlparse(src)
                            clean_src = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_src, 'type': 'svg'})
                    for tag in soup.find_all('object'):
                        data = tag.get('data')
                        if data and data.lower().endswith('.svg'):
                            parsed = urlparse(data)
                            clean_data = urlunparse(parsed._replace(query=''))
                            media_assets.append({'url': clean_data, 'type': 'svg'})
        # Find pagination links if enabled
        next_links = []
        list_links = []
        if request.follow_pagination and request.pagination_selector:
            if request.pagination_type == "next":
                # Type A: single next link
                a = soup.select_one(request.pagination_selector)
                if a:
                    href = a.get('href')
                    if href:
                        if not href.startswith('http'):
                            from urllib.parse import urljoin
                            href = urljoin(url, href)
                        next_links.append(href)
            elif request.pagination_type == "list":
                # Type B: list of all page links
                for a in soup.select(request.pagination_selector):
                    href = a.get('href')
                    if href:
                        if not href.startswith('http'):
                            from urllib.parse import urljoin
                            href = urljoin(url, href)
                        list_links.append(href)
                        next_links.append(href)
        return results, media_assets, None, next_links, list_links

    all_results = []
    all_media = []
    errors = []
    visited = set()
    # If explicit pagination_links are provided, use them as the to_visit list (and only those)
    if request.pagination_links:
        # Only use the provided pagination links for scraping (do not add the main url again)
        to_visit = list(dict.fromkeys(request.pagination_links))
    else:
        to_visit = [request.url]
    scraped_pages = []
    list_pagination_urls = set()

    print(f"Starting scrape for URL: {request.pagination_selector}")
    # Always populate list_pagination_urls with all hrefs matching the pagination selector, if provided
    if request.pagination_selector:
        print(f"Fetching initial page for pagination selector: {request.pagination_selector}")
        try:
            response = requests.get(request.url)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            found_any = False
            for a in soup.select(request.pagination_selector):
                href = a.get('href')
                if href:
                    if not href.startswith('http'):
                        from urllib.parse import urljoin
                        href = urljoin(request.url, href)
                    list_pagination_urls.add(href)
                    found_any = True
            if not found_any:
                errors.append(f"No elements found matching pagination selector: {request.pagination_selector}")
        except Exception as e:
            errors.append(f"Error fetching or parsing initial page for pagination selector: {str(e)}")
    if request.follow_pagination and request.pagination_type == "list":
        # Always include the initial URL in list_pagination_urls
        list_pagination_urls.add(request.url)
    while to_visit:
        current_url = to_visit.pop(0)
        if current_url in visited:
            continue
        visited.add(current_url)
        scraped_pages.append(current_url)
        results, media_assets, err, next_links, list_links = scrape_single(current_url)
        if err:
            errors.append(f"{current_url}: {err}")
            continue
        if results:
            all_results.extend(results)
        if media_assets:
            all_media.extend(media_assets)
        # For list pagination, accumulate all discovered list links
        if not request.pagination_links and request.follow_pagination and request.pagination_type == "list":
            for link in list_links:
                list_pagination_urls.add(link)
        if not request.pagination_links:
            for link in next_links:
                if link not in visited and link not in to_visit:
                    to_visit.append(link)
    response = {"results": all_results, "media_assets": all_media, "scraped_pages": scraped_pages, "errors": errors}
    # Always include pagination URLs in the response
    response["list_pagination_urls"] = list(list_pagination_urls)
    return response

@app.post("/download-media")
def download_media(data: dict):
    urls = data.get('urls', [])
    zip_name = data.get('zip_name', 'media-assets.zip')
    temp_dir = tempfile.mkdtemp()
    file_paths = []
    # Download each file to temp_dir
    for url in urls:
        try:
            r = requests.get(url, timeout=10)
            r.raise_for_status()
            filename = url.split("/")[-1] or "file"
            file_path = os.path.join(temp_dir, filename)
            with open(file_path, 'wb') as f:
                f.write(r.content)
            file_paths.append(file_path)
        except Exception:
            continue
    # Create zip file in temp_dir
    zip_path = os.path.join(temp_dir, zip_name)
    with zipfile.ZipFile(zip_path, "w", allowZip64=True) as zf:
        for file_path in file_paths:
            # Write with the original filename, which can contain unicode
            zf.write(file_path, os.path.basename(file_path))
    # Stream the zip file as a response
    def iterfile():
        with open(zip_path, "rb") as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                yield chunk
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)
    from urllib.parse import quote
    quoted_zip_name = quote(zip_name)
    content_disposition = f"attachment; filename*=UTF-8''{quoted_zip_name}"
    return StreamingResponse(iterfile(), media_type="application/zip", headers={"Content-Disposition": content_disposition})

@app.get("/download-temp-zip")
def download_temp_zip(dir: str, zip: str):
    temp_dir = os.path.join(tempfile.gettempdir(), dir)
    zip_path = os.path.join(temp_dir, zip)
    if not os.path.exists(zip_path):
        raise HTTPException(status_code=404, detail="ZIP file not found or expired.")
    def iterfile():
        with open(zip_path, "rb") as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                yield chunk
    return StreamingResponse(iterfile(), media_type="application/zip", headers={"Content-Disposition": f"attachment; filename={zip}"})

@app.delete("/delete-temp-zip")
def delete_temp_zip(dir: str, zip: str):
    import shutil
    temp_dir = os.path.join(tempfile.gettempdir(), dir)
    zip_path = os.path.join(temp_dir, zip)
    if os.path.exists(zip_path):
        try:
            os.remove(zip_path)
        except Exception:
            pass
    if os.path.exists(temp_dir):
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass
    return {"status": "deleted"}

@app.get("/")
def root():
    return {"message": "AudioBreak Scraper API"}

@app.post("/scrape-metadata")
def scrape_metadata(request: ScrapeRequest):
    """
    Initial endpoint to detect pagination links and provide metadata for UI configuration.
    """
    try:
        response = requests.get(request.url)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
    except Exception as e:
        return {"error": str(e)}

    # Try to detect possible pagination links/selectors
    pagination_candidates = []
    for selector in ["a.next", ".next", "a[rel=next]", "li.next a", "a[aria-label=Next]", "a[title=Next]", "a[rel=page]", "a.page-link"]:
        found = soup.select(selector)
        if found:
            pagination_candidates.append({
                "selector": selector,
                "count": len(found),
                "examples": [a.get('href') for a in found[:3] if a.get('href')]
            })

    # Heuristic: find links with similar URLs to the initial URL (likely pagination)
    from urllib.parse import urlparse, urljoin
    import re
    base_url = request.url
    parsed_base = urlparse(base_url)
    base_netloc = parsed_base.netloc
    base_path = parsed_base.path.rstrip('/')
    similar_links = []
    for a in soup.find_all('a', href=True):
        href = a['href']
        # Make absolute
        abs_href = urljoin(base_url, href)
        parsed_href = urlparse(abs_href)
        # Heuristic: same domain, path starts with base path, and has a number or 'page' in it
        if parsed_href.netloc == base_netloc and parsed_href.path.startswith(base_path):
            if re.search(r'(page|p=|[0-9]{1,3})', abs_href, re.IGNORECASE):
                similar_links.append(abs_href)
    # Deduplicate and limit examples
    similar_links = list(dict.fromkeys(similar_links))[:10]

    # Detect available media types
    media_types = set()
    if soup.find('img'): media_types.add('img')
    if soup.find('audio') or any((t for t in soup.find_all('source') if t.parent and getattr(t.parent, 'name', None) == 'audio')): media_types.add('audio')
    if soup.find('video') or any((t for t in soup.find_all('source') if t.parent and getattr(t.parent, 'name', None) == 'video')): media_types.add('video')
    if soup.find('a', href=lambda h: h and h.lower().endswith('.pdf')): media_types.add('pdf')
    if soup.find('img', src=lambda s: s and s.lower().endswith('.svg')) or soup.find('object', data=lambda d: d and d.lower().endswith('.svg')): media_types.add('svg')

    # Suggest main content selectors
    main_selectors = []
    for sel in ['main', '#main', '.main', '#content', '.content', 'article', '.article', '#primary']:
        if soup.select_one(sel):
            main_selectors.append(sel)

    return {
        "pagination_candidates": pagination_candidates,
        "pagination_similar_links": similar_links,
        "media_types": list(media_types),
        "main_selectors": main_selectors,
        "title": soup.title.string.strip() if soup.title and soup.title.string else None
    }

# In-memory progress store (for demo; use Redis for production)
progress_store = {}
progress_store_lock = threading.Lock()

# Track job start/last update time
CLEANUP_INTERVAL_SECONDS = 3600  # 1 hour
STALE_JOB_SECONDS = 3600 * 2     # 2 hours

def cleanup_progress_store():
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        now = datetime.datetime.utcnow().timestamp()
        with progress_store_lock:
            stale_jobs = []
            for job_id, prog in list(progress_store.items()):
                # If job is not ready and status is not 'ready', skip
                if not prog.get('ready') and prog.get('status') != 'ready':
                    continue  # still active
                # If job is ready but not downloaded for a long time, or error
                last_update = prog.get('last_update', now)
                if now - last_update > STALE_JOB_SECONDS:
                    # Remove temp dir if exists
                    temp_dir = prog.get('temp_dir')
                    if temp_dir and os.path.exists(temp_dir):
                        import shutil
                        shutil.rmtree(temp_dir, ignore_errors=True)
                    stale_jobs.append(job_id)
            for job_id in stale_jobs:
                progress_store.pop(job_id, None)

# Start cleanup thread on app startup
threading.Thread(target=cleanup_progress_store, daemon=True).start()

@app.post("/start-download-media")
def start_download_media(data: dict):
    """
    Starts the download and zipping process in a background thread, returns a job_id.
    """
    job_id = str(uuid.uuid4())
    urls = data.get('urls', [])
    zip_name = data.get('zip_name', 'media-assets.zip')
    progress_store[job_id] = {
        'status': 'starting',
        'current': 0,
        'total': len(urls),
        'zip_size': 0,
        'zip_name': zip_name,
        'error': None,
        'ready': False,
        'temp_dir': None,
        'zip_path': None,
        'last_update': datetime.datetime.utcnow().timestamp()
    }
    def worker():
        temp_dir = tempfile.mkdtemp()
        file_paths = []
        with progress_store_lock:
            progress_store[job_id]['temp_dir'] = temp_dir
            progress_store[job_id]['last_update'] = time.time()
        # Download each file
        for idx, url in enumerate(urls):
            try:
                r = requests.get(url, timeout=10)
                r.raise_for_status()
                filename = url.split("/")[-1] or "file"
                file_path = os.path.join(temp_dir, filename)
                with open(file_path, 'wb') as f:
                    f.write(r.content)
                file_paths.append(file_path)
            except Exception as e:
                continue
            with progress_store_lock:
                progress_store[job_id]['current'] = idx + 1
                # Always set status to 'Downloading Files' (frontend shows current/total)
                progress_store[job_id]['status'] = "Downloading Files"
                progress_store[job_id]['last_update'] = time.time()
        # Prepare ZIP
        zip_path = os.path.join(temp_dir, zip_name)
        with progress_store_lock:
            progress_store[job_id]['status'] = "Preparing ZIP..."
            progress_store[job_id]['last_update'] = time.time()
        with zipfile.ZipFile(zip_path, "w", allowZip64=True) as zf:
            for file_path in file_paths:
                zf.write(file_path, os.path.basename(file_path))
        with progress_store_lock:
            progress_store[job_id]['zip_path'] = zip_path
            progress_store[job_id]['zip_size'] = os.path.getsize(zip_path)
            progress_store[job_id]['status'] = "ready"
            progress_store[job_id]['ready'] = True
            progress_store[job_id]['last_update'] = time.time()
    threading.Thread(target=worker, daemon=True).start()
    return {"job_id": job_id}

@app.get("/download-progress/{job_id}")
def download_progress(job_id: str):
    """
    SSE endpoint for progress updates.
    """
    def event_stream():
        last_status = None
        while True:
            with progress_store_lock:
                prog = progress_store.get(job_id)
                if prog:
                    prog['last_update'] = time.time()
            if not prog:
                yield f"event: error\ndata: {json.dumps({'error': 'Job not found'})}\n\n"
                break
            if prog['status'] != last_status or prog['ready']:
                yield f"data: {json.dumps(prog)}\n\n"
                last_status = prog['status']
            if prog['ready'] or prog['error']:
                break
            time.sleep(0.5)
    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.get("/download-ready/{job_id}")
def download_ready(job_id: str):
    prog = progress_store.get(job_id)
    if not prog or not prog.get('ready'):
        return {"ready": False}
    return {"ready": True, "zip_name": prog['zip_name']}

@app.get("/download-zip/{job_id}")
def download_zip(job_id: str):
    prog = progress_store.get(job_id)
    if not prog or not prog.get('ready'):
        raise HTTPException(status_code=404, detail="ZIP not ready")
    zip_path = prog['zip_path']
    zip_name = prog['zip_name']
    def iterfile():
        with open(zip_path, "rb") as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                yield chunk
        import shutil
        shutil.rmtree(prog['temp_dir'], ignore_errors=True)
        progress_store.pop(job_id, None)
    from urllib.parse import quote
    quoted_zip_name = quote(zip_name)
    content_disposition = f"attachment; filename*=UTF-8''{quoted_zip_name}"
    return StreamingResponse(iterfile(), media_type="application/zip", headers={"Content-Disposition": content_disposition})
