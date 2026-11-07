import { createRouter, createWebHistory } from 'vue-router'

import DashboardView from '@/views/DashboardView.vue'

const routes = [
  { path: '/supervisor', name: 'supervisor', component: () => import('@/views/SupervisorView.vue'), meta: { title: 'Supervisor' } },
  { path: '/models', name: 'models', component: () => import('@/views/ModelAvailabilityView.vue'), meta: { title: 'Model availability' } },
  { path: '/verification', name: 'verification', component: () => import('@/views/VerificationView.vue'), meta: { title: 'Full verification' } },
  {
    path: '/',
    name: 'dashboard',
    component: DashboardView,
    meta: { title: 'Dashboard' }
  },
  {
    // The drawer lists every project, so the overview page it used to link to
    // has no job left. Kept as a redirect so old links still land somewhere.
    path: '/projects',
    redirect: '/'
  },
  {
    path: '/projects/:project',
    name: 'project-issues',
    component: () => import('@/views/ProjectIssuesView.vue'),
    meta: { title: 'Issues' }
  },
  {
    path: '/projects/:project/:id',
    name: 'issue',
    component: () => import('@/views/IssueView.vue'),
    meta: { title: 'Issue' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: 'Not found' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · devpanel` : 'devpanel'
})

export default router
