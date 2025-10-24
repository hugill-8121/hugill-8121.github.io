/**
 * 博客工具函数
 * 包含容器切换、Markdown渲染等通用功能
 */

// 容器切换函数
export function switchToList(dom) {
    dom.containers.list.classList.add('container-active');
    dom.containers.list.classList.remove('container-hidden');
    dom.containers.show.classList.add('container-hidden');
    dom.containers.show.classList.remove('container-active');
    dom.containers.edit.classList.add('container-hidden');
    dom.containers.edit.classList.remove('container-active');
}

export function switchToShow(blog, dom) {
    dom.containers.list.classList.add('container-hidden');
    dom.containers.list.classList.remove('container-active');
    dom.containers.show.classList.add('container-active');
    dom.containers.show.classList.remove('container-hidden');
    dom.containers.edit.classList.add('container-hidden');
    dom.containers.edit.classList.remove('container-active');
}

export function switchToEdit(blog, dom) {
    // 填充编辑表单
    dom.editTitle.value = blog.title;
    dom.editTags.value = blog.tags.join(',');
    
    // 加载原始Markdown内容
    dom.editStatus.textContent = '';
    fetch(blog.path)
        .then(res => res.text())
        .then(content => {
            dom.editContent.value = content;
        })
        .catch(err => {
            console.error('加载编辑内容失败:', err);
            dom.editStatus.textContent = `加载失败: ${err.message}`;
            dom.editStatus.className = 'status error';
        });

    // 切换容器
    dom.containers.show.classList.add('container-hidden');
    dom.containers.show.classList.remove('container-active');
    dom.containers.edit.classList.add('container-active');
    dom.containers.edit.classList.remove('container-hidden');
}

// 加载博客内容
export function loadBlogContent(blog, dom, renderMarkdownFunc) {
    // 显示加载状态
    dom.showLoading.style.display = 'block';
    dom.showContent.style.display = 'none';
    dom.showError.style.display = 'none';

    // 设置标题和标签
    dom.showTitle.textContent = blog.title;
    dom.showTags.innerHTML = '';
    blog.tags.forEach(tag => {
        const tagElement = document.createElement('span');
        tagElement.className = 'tag';
        tagElement.textContent = tag;
        dom.showTags.appendChild(tagElement);
    });

    // 加载并渲染内容
    fetch(blog.path)
        .then(res => {
            if (!res.ok) throw new Error(`加载失败: ${res.statusText}`);
            return res.text();
        })
        .then(markdown => {
            const html = renderMarkdownFunc(markdown);
            dom.showContent.innerHTML = html;
            
            // 代码高亮
            if (window.Prism) {
                Prism.highlightAll();
            }
            
            // 渲染数学公式
            if (window.MathJax) {
                MathJax.Hub.Queue(["Typeset", MathJax.Hub, dom.showContent]);
            }
            
            // 显示内容
            dom.showLoading.style.display = 'none';
            dom.showContent.style.display = 'block';
        })
        .catch(err => {
            console.error('加载博客内容失败:', err);
            dom.showLoading.style.display = 'none';
            dom.showError.textContent = `加载失败: ${err.message}`;
            dom.showError.style.display = 'block';
        });
}

// Markdown渲染函数
export function renderMarkdown(markdownContent) {
    // 处理代码块
    let processedContent = markdownContent
        .replace(/~~~~\{(.*?)\}\n([\s\S]*?)~~~~/g, (match, lang, code) => {
            return `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
        })
        .replace(/~~~~\n([\s\S]*?)~~~~/g, (match, code) => {
            return `<pre><code>${escapeHtml(code)}</code></pre>`;
        });

    // 使用showdown转换为HTML
    const converter = new showdown.Converter({
        tables: true,
        tasklists: true,
        strikethrough: true,
        ghCodeBlocks: true
    });
    return converter.makeHtml(processedContent);
}

// HTML转义函数
function escapeHtml(markdown) {
    return markdown
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}